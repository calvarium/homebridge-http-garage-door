const packageJson = require('../package.json');
const HttpClient = require('./httpClient');
const WebhookServer = require('./webhookServer');
const DeconzClient = require('./deconzClient');

// HAP Door State Konstanten
const DOOR_STATE = {
    OPEN: 0,
    CLOSED: 1,
    OPENING: 2,
    CLOSING: 3,
    STOPPED: 4,
};

let Service;
let Characteristic;

class GarageDoorOpener {
    static instances = [];
    constructor(log, config) {
        this.log = log;
        this.config = config;

        this.name = config.name;
        this.openURL = config.openURL;
        this.closeURL = config.closeURL;
        this.openTime = config.openTime || 10;
        this.closeTime = config.closeTime || 10;
        this.switchOff = config.switchOff || false;
        this.switchOffDelay = config.switchOffDelay || 2;
        this.switchOffURL = config.switchOffURL || config.openURL;
        this.autoClose = config.autoClose || false;
        this.autoCloseDelay = config.autoCloseDelay || 3600;
        this.autoCloseTimer = null;
        this.manufacturer = config.manufacturer || (typeof packageJson.author === 'string' ? packageJson.author : packageJson.author.name);
        this.serial = config.serial || packageJson.version;
        this.model = config.model || packageJson.name;
        this.firmware = config.firmware || packageJson.version;
        this.username = config.username || null;
        this.password = config.password || null;
        this.timeout = config.timeout || 3000;
        this.webhookPort = config.webhookPort || null;
        // Config-Key http_method (snake_case) wird intern als httpMethod (camelCase) geführt
        this.httpMethod = config.http_method || 'GET';
        this.polling = config.polling || false;
        this.pollInterval = config.pollInterval || 120;
        this.statusURL = config.statusURL;
        this.statusKey = config.statusKey || '$.inputs[0].input';
        this.statusValueOpen = config.statusValueOpen || '0';
        this.statusValueClosed = config.statusValueClosed || '1';
        this.statusValueOpening = config.statusValueOpening || '2';
        this.statusValueClosing = config.statusValueClosing || '3';
        this.rejectUnauthorized = config.rejectUnauthorized !== false;

        this.deconzDeviceId = config.deconzDeviceId || null;
        this.deconzHost = config.deconzHost || 'localhost';
        this.deconzPort = config.deconzPort || 443;

        if (this.username != null && this.password != null) {
            this.auth = { user: this.username, pass: this.password };
        }

        this.httpClient = new HttpClient(this.log, {
            debug: this.config.debug,
            httpMethod: this.httpMethod,
            timeout: this.timeout,
            auth: this.auth,
            rejectUnauthorized: this.rejectUnauthorized,
        });

        if (this.webhookPort) {
            this.webhookServer = new WebhookServer(
                this.log,
                this.webhookPort,
                this.config.debug,
                () => this.handleWebhook(),
            );
        }

        if (this.deconzDeviceId) {
            this.deconzClient = new DeconzClient(this.log, {
                host: this.deconzHost,
                port: this.deconzPort,
                deviceId: this.deconzDeviceId,
                debug: this.config.debug,
            });
        }

        this.service = new Service.GarageDoorOpener(this.name);
        this.informationService = null;
        this.movementTimeout = null;
        this.ignoreDeconzOpen = false;
        this.pollIntervalHandle = null;
        this._statusPending = false;
        this._webhookDebounceTimer = null;

        GarageDoorOpener.instances.push(this);
    }

    static configure(service, characteristic) {
        Service = service;
        Characteristic = characteristic;
    }

    identify(callback) {
        this.log('Identify requested!');
        callback();
    }

    _httpRequest(url, body, method, callback) {
        this.httpClient.request(url, body, method, callback);
    }

    _getStatus(callback) {
        if (this._statusPending) {
            if (this.config.debug) {
                this.log('_getStatus skipped: previous request still in flight');
            }
            // Pass a sentinel so callers can distinguish "skipped" from "success".
            callback(null, /* skipped */ true);
            return;
        }
        this._statusPending = true;
        this.httpClient.getStatus(
            this.statusURL,
            this.statusKey,
            {
                open: this.statusValueOpen,
                closed: this.statusValueClosed,
                opening: this.statusValueOpening,
                closing: this.statusValueClosing,
            },
            (error, statusValue) => {
                this._statusPending = false;
                if (error) {
                    this.log.error('Error getting status: %s', error.message);
                    this.service
                        .getCharacteristic(Characteristic.CurrentDoorState)
                        .updateValue(new Error('Polling failed'));
                    callback(error);
                } else {
                    this.service
                        .getCharacteristic(Characteristic.CurrentDoorState)
                        .updateValue(statusValue);
                    // TargetDoorState nur synchronisieren wenn kein aktiver
                    // Bewegungsvorgang läuft (vermeidet Race Condition mit laufendem Poll)
                    if (!this.movementTimeout) {
                        this.service
                            .getCharacteristic(Characteristic.TargetDoorState)
                            .updateValue(statusValue <= DOOR_STATE.CLOSED ? statusValue : DOOR_STATE.OPEN);
                    }
                    if (this.config.debug) {
                        this.log('Updated door state to: %s', statusValue);
                    }
                    callback();
                }
            },
        );
    }

    setTargetDoorState(value, callback) {
        let url;
        this.log('Setting targetDoorState to %s', value);
        if (value === DOOR_STATE.CLOSED) {
            url = this.closeURL;
        } else {
            url = this.openURL;
        }
        if (this.config.debug) {
            this.log('Requesting URL: %s', url);
        }
        this._httpRequest(url, '', this.httpMethod, (error) => {
            if (error) {
                this.log.warn('Error setting targetDoorState: %s', error.message);
                callback(error);
            } else {
                if (value !== DOOR_STATE.CLOSED) {
                    if (this.switchOff) {
                        this.switchOffFunction();
                    }
                    if (this.autoClose) {
                        this._scheduleAutoClose();
                    }
                }
                callback();
            }
        });
    }

    getCurrentDoorState() {
        return this.service.getCharacteristic(Characteristic.CurrentDoorState).value;
    }

    simulateOpen() {
        if (this.config.debug) {
            this.log('simulateOpen called');
        }
        if (this.movementTimeout) {
            clearTimeout(this.movementTimeout);
        }
        this.ignoreDeconzOpen = true;
        this.service
            .getCharacteristic(Characteristic.CurrentDoorState)
            .updateValue(DOOR_STATE.OPENING);
        this.movementTimeout = setTimeout(() => {
            this.ignoreDeconzOpen = false;
            this.movementTimeout = null;
            this._getStatus(() => {});
            this.log('Finished opening');
        }, this.openTime * 1000);
    }

    simulateClose() {
        if (this.config.debug) {
            this.log('simulateClose called');
        }
        this._cancelAutoClose();
        if (this.movementTimeout) {
            clearTimeout(this.movementTimeout);
        }
        this.ignoreDeconzOpen = false;
        this.service
            .getCharacteristic(Characteristic.CurrentDoorState)
            .updateValue(DOOR_STATE.CLOSING);
        this.movementTimeout = setTimeout(() => {
            this.movementTimeout = null;
            this._getStatus(() => {});
            this.log('Finished closing');
        }, this.closeTime * 1000);
    }

    _scheduleAutoClose() {
        this._cancelAutoClose();
        this.log('Auto-close scheduled in %s seconds', this.autoCloseDelay);
        this.autoCloseTimer = setTimeout(() => {
            this.autoCloseTimer = null;
            this.log('Auto-close timer fired, checking door state...');
            const execute = () => {
                const current = this.getCurrentDoorState();
                // OPEN/OPENING — beides als "noch offen" werten
                if (current === DOOR_STATE.OPEN || current === DOOR_STATE.OPENING) {
                    this.log.warn('Auto-close: door still open, triggering close');
                    this.service.setCharacteristic(Characteristic.TargetDoorState, DOOR_STATE.CLOSED);
                } else {
                    this.log('Auto-close: door already closed, nothing to do');
                }
            };
            if (this.polling) {
                // Frischen Status holen, dann entscheiden.
                // Second argument is `true` when the request was skipped (still in flight);
                // in that case we still run execute() because the cached state is recent.
                this._getStatus((_err, skipped) => {
                    if (_err && !skipped) {
                        this.log.warn('Auto-close: could not refresh status, skipping');
                        return;
                    }
                    execute();
                });
            } else {
                // Ohne Sensor konservativ direkt schließen
                execute();
            }
        }, this.autoCloseDelay * 1000);
    }

    _cancelAutoClose() {
        if (this.autoCloseTimer) {
            clearTimeout(this.autoCloseTimer);
            this.autoCloseTimer = null;
            if (this.config.debug) {
                this.log('Auto-close timer cancelled');
            }
        }
    }

    switchOffFunction() {
        if (this.config.debug) {
            this.log('switchOffFunction called');
        }
        this.log('Waiting %s seconds for switch off', this.switchOffDelay);
        setTimeout(() => {
            this.log('SwitchOff...');
            this._httpRequest(this.switchOffURL, '', this.httpMethod, () => {});
        }, this.switchOffDelay * 1000);
    }

    handleWebhook() {
        // Debounce rapid successive webhook calls (e.g. contact-sensor bounce).
        // Only the last call within 300 ms will actually be processed.
        if (this._webhookDebounceTimer) {
            clearTimeout(this._webhookDebounceTimer);
        }
        this._webhookDebounceTimer = setTimeout(() => {
            this._webhookDebounceTimer = null;
            this._handleWebhookDebounced();
        }, 300);
    }

    _handleWebhookDebounced() {
        const currentState = this.getCurrentDoorState();
        const targetState = this.service.getCharacteristic(Characteristic.TargetDoorState).value;
        if (this.config.debug) {
            this.log('Webhook received, currentState: %s, targetState: %s', currentState, targetState);
        }

        // Wenn Polling deaktiviert und der initiale Status noch unbekannt ist (null),
        // erst einen frischen Status holen bevor die Webhook-Logik greift
        if (!this.polling && this.statusURL && currentState === null) {
            if (this.config.debug) {
                this.log('Webhook: initial state unknown, fetching status first');
            }
            this._getStatus(() => this._processWebhookState());
            return;
        }

        this._processWebhookState();
    }

    _processWebhookState() {
        // Snapshot both values before any updateValue call to avoid reading
        // a targetState that was already mutated during this processing run.
        const currentState = this.getCurrentDoorState();
        const targetState = this.service.getCharacteristic(Characteristic.TargetDoorState).value;
        try {
            switch (currentState) {
                case DOOR_STATE.CLOSED: // Closed -> start opening
                    this.log('Started opening');
                    this.service
                        .getCharacteristic(Characteristic.TargetDoorState)
                        .updateValue(DOOR_STATE.OPEN);
                    this.simulateOpen();
                    if (this.autoClose) {
                        this._scheduleAutoClose();
                    }
                    break;
                case DOOR_STATE.OPEN: // Open -> start closing
                    this.log('Started closing');
                    this.service
                        .getCharacteristic(Characteristic.TargetDoorState)
                        .updateValue(DOOR_STATE.CLOSED);
                    this.simulateClose();
                    break;
                case DOOR_STATE.OPENING: // Opening -> stop
                case DOOR_STATE.CLOSING: // Closing -> stop
                    this.log('Stopping movement');
                    if (this.movementTimeout) {
                        clearTimeout(this.movementTimeout);
                        this.movementTimeout = null;
                    }
                    this.service
                        .getCharacteristic(Characteristic.CurrentDoorState)
                        .updateValue(DOOR_STATE.STOPPED);
                    break;
                case DOOR_STATE.STOPPED: // Stopped -> reverse direction
                    if (targetState === DOOR_STATE.OPEN) {
                        this.log('Reversing to close');
                        this.service
                            .getCharacteristic(Characteristic.TargetDoorState)
                            .updateValue(DOOR_STATE.CLOSED);
                        this.simulateClose();
                    } else {
                        this.log('Reversing to open');
                        this.service
                            .getCharacteristic(Characteristic.TargetDoorState)
                            .updateValue(DOOR_STATE.OPEN);
                        this.simulateOpen();
                        if (this.autoClose) {
                            this._scheduleAutoClose();
                        }
                    }
                    break;
            }
        } catch (err) {
            this.log.error('Failed to handle webhook: %s', err.message);
        }
    }

    startWebhookServer() {
        if (this.webhookServer) {
            this.webhookServer.start();
        }
    }

    startDeconzListener() {
        if (this.deconzClient) {
            this.deconzClient.connect((state) => {
                if (typeof state.open !== 'undefined') {
                    if (state.open && this.ignoreDeconzOpen) {
                        if (this.config.debug) {
                            this.log('Ignoring deCONZ open event while opening');
                        }
                        return;
                    }

                    const newState = state.open ? DOOR_STATE.OPEN : DOOR_STATE.CLOSED;

                    if (!state.open && this.movementTimeout && this.getCurrentDoorState() === DOOR_STATE.CLOSING) {
                        clearTimeout(this.movementTimeout);
                        this.movementTimeout = null;
                    }

                    const finalCurrent = state.open ? Characteristic.CurrentDoorState.OPEN
                        : Characteristic.CurrentDoorState.CLOSED;

                    this.ignoreDeconzOpen = false;

                    this.syncFinalState(finalCurrent);

                    if (state.open) {
                        if (this.autoClose) {
                            this._scheduleAutoClose();
                        }
                    } else {
                        this._cancelAutoClose();
                    }

                    if (this.config.debug) {
                        this.log('Updated door state from deCONZ to: %s', newState);
                    }
                }
            });
        }
    }

    syncFinalState(finalCurrent) {
        const { CurrentDoorState, TargetDoorState } = Characteristic;

        // 1) Current sofort
        this.service.updateCharacteristic(CurrentDoorState, finalCurrent);

        // 2) Target nachziehen (nur 0/1)
        const targetWanted = (finalCurrent === CurrentDoorState.OPEN)
            ? TargetDoorState.OPEN
            : TargetDoorState.CLOSED;

        // nur senden, wenn wirklich unterschiedlich, sonst erzwingen:
        const tChar = this.service.getCharacteristic(TargetDoorState);
        if (tChar.value !== targetWanted) {
            // kleiner Delay, damit iOS zwei getrennte Events sieht
            setTimeout(() => tChar.updateValue(targetWanted), 20);
        }
    }

    stopPolling() {
        if (this.pollIntervalHandle) {
            clearInterval(this.pollIntervalHandle);
            this.pollIntervalHandle = null;
            if (this.config.debug) {
                this.log('Polling interval stopped');
            }
        }
    }

    stopWebhookServer() {
        if (this.webhookServer) {
            this.webhookServer.stop();
        }
    }

    stopDeconzListener() {
        if (this.deconzClient) {
            this.deconzClient.close();
        }
    }

    getServices() {
        if (this.config.debug) {
            this.log('Initializing services');
        }
        this.informationService = new Service.AccessoryInformation();
        this.informationService
            .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
            .setCharacteristic(Characteristic.Model, this.model)
            .setCharacteristic(Characteristic.SerialNumber, this.serial)
            .setCharacteristic(Characteristic.FirmwareRevision, this.firmware);

        this.service
            .getCharacteristic(Characteristic.TargetDoorState)
            .on('set', this.setTargetDoorState.bind(this));

        if (this.polling) {
            if (this.config.debug) {
                this.log('Polling enabled with interval %s seconds', this.pollInterval);
            }
            this._getStatus(() => {});
            this.pollIntervalHandle = setInterval(() => {
                this._getStatus(() => {});
            }, this.pollInterval * 1000);
        } else {
            if (this.config.debug) {
                this.log('Polling disabled');
            }
            // Wenn eine statusURL konfiguriert ist, einmalig den echten Status holen.
            // Ansonsten sicher auf CLOSED initialisieren.
            if (this.statusURL) {
                this._getStatus(() => {});
            } else {
                this.service
                    .getCharacteristic(Characteristic.CurrentDoorState)
                    .updateValue(DOOR_STATE.CLOSED);
                this.service
                    .getCharacteristic(Characteristic.TargetDoorState)
                    .updateValue(DOOR_STATE.CLOSED);
            }
        }

        return [this.informationService, this.service];
    }
}

module.exports = GarageDoorOpener;
