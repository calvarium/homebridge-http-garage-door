const packageJson = require('../package.json');
const HttpClient = require('./httpClient');
const WebhookServer = require('./webhookServer');
const DeconzClient = require('./deconzClient');

let Service;
let Characteristic;
const instances = [];

class GarageDoorOpener {
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
        this.manufacturer = config.manufacturer || packageJson.author.name;
        this.serial = config.serial || packageJson.version;
        this.model = config.model || packageJson.name;
        this.firmware = config.firmware || packageJson.version;
        this.username = config.username || null;
        this.password = config.password || null;
        this.timeout = config.timeout || 3000;
        this.webhookPort = config.webhookPort || null;
        this.http_method = config.http_method || 'GET';
        this.polling = config.polling || false;
        this.pollInterval = config.pollInterval || 120;
        this.statusURL = config.statusURL;
        this.statusKey = config.statusKey || '$.inputs[0].input';
        this.statusValueOpen = config.statusValueOpen || '0';
        this.statusValueClosed = config.statusValueClosed || '1';
        this.statusValueOpening = config.statusValueOpening || '2';
        this.statusValueClosing = config.statusValueClosing || '3';

        this.deconzDeviceId = config.deconzDeviceId || null;
        this.deconzHost = config.deconzHost || 'localhost';
        this.deconzPort = config.deconzPort || 443;

        if (this.username != null && this.password != null) {
            this.auth = { user: this.username, pass: this.password };
        }

        this.httpClient = new HttpClient(this.log, {
            debug: this.config.debug,
            http_method: this.http_method,
            timeout: this.timeout,
            auth: this.auth,
        });

        if (this.webhookPort) {
            this.webhookServer = new WebhookServer(
                this.log,
                this.webhookPort,
                this.config.debug,
                () => this.handleWebhook()
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

        instances.push(this);
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
                    this.service
                        .getCharacteristic(Characteristic.TargetDoorState)
                        .updateValue(statusValue);
                    if (this.config.debug) {
                        this.log('Updated door state to: %s', statusValue);
                    }
                    callback();
                }
            }
        );
    }

    setTargetDoorState(value, callback) {
        let url;
        this.log('Setting targetDoorState to %s', value);
        if (value === 1) {
            url = this.closeURL;
        } else {
            url = this.openURL;
        }
        if (this.config.debug) {
            this.log('Requesting URL: %s', url);
        }
        this._httpRequest(url, '', this.http_method, (error) => {
            if (error) {
                this.log.warn('Error setting targetDoorState: %s', error.message);
                callback(error);
            } else {
                if (value !== 1) {
                    if (this.switchOff) {
                        this.switchOffFunction();
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
            .updateValue(2);
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
        if (this.movementTimeout) {
            clearTimeout(this.movementTimeout);
        }
        this.ignoreDeconzOpen = false;
        this.service
            .getCharacteristic(Characteristic.CurrentDoorState)
            .updateValue(3);
        this.movementTimeout = setTimeout(() => {
            this.movementTimeout = null;
            this._getStatus(() => {});
            this.log('Finished closing');
        }, this.closeTime * 1000);
    }

    switchOffFunction() {
        if (this.config.debug) {
            this.log('switchOffFunction called');
        }
        this.log('Waiting %s seconds for switch off', this.switchOffDelay);
        setTimeout(() => {
            this.log('SwitchOff...');
            this._httpRequest(this.closeURL, '', this.http_method, () => {});
        }, this.switchOffDelay * 1000);
    }

    handleWebhook() {
        const currentState = this.getCurrentDoorState();
        const targetState = this.service.getCharacteristic(Characteristic.TargetDoorState).value;
        if (this.config.debug) {
            this.log('Webhook received, currentState: %s, targetState: %s', currentState, targetState);
        }
        try {
            switch (currentState) {
                case 1: // Closed -> start opening
                    this.log('Started opening');
                    this.service
                        .getCharacteristic(Characteristic.TargetDoorState)
                        .updateValue(0);
                    this.simulateOpen();
                    break;
                case 0: // Open -> start closing
                    this.log('Started closing');
                    this.service
                        .getCharacteristic(Characteristic.TargetDoorState)
                        .updateValue(1);
                    this.simulateClose();
                    break;
                case 2: // Opening -> stop
                case 3: // Closing -> stop
                    this.log('Stopping movement');
                    if (this.movementTimeout) {
                        clearTimeout(this.movementTimeout);
                        this.movementTimeout = null;
                    }
                    this.service
                        .getCharacteristic(Characteristic.CurrentDoorState)
                        .updateValue(4);
                    break;
                case 4: // Stopped -> reverse direction
                    if (targetState === 0) {
                        this.log('Reversing to close');
                        this.service
                            .getCharacteristic(Characteristic.TargetDoorState)
                            .updateValue(1);
                        this.simulateClose();
                    } else {
                        this.log('Reversing to open');
                        this.service
                            .getCharacteristic(Characteristic.TargetDoorState)
                            .updateValue(0);
                        this.simulateOpen();
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

                    const newState = state.open ? 0 : 1;

                    if (!state.open && this.movementTimeout && this.getCurrentDoorState() === 3) {
                        clearTimeout(this.movementTimeout);
                        this.movementTimeout = null;
                    }

                    const finalCurrent = state.open ? Characteristic.CurrentDoorState.OPEN
                                : Characteristic.CurrentDoorState.CLOSED;

                    this.ignoreDeconzOpen = false;

                    this.syncFinalState(finalCurrent);
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
            setInterval(() => {
                this._getStatus(() => {});
            }, this.pollInterval * 1000);
        } else {
            if (this.config.debug) {
                this.log('Polling disabled');
            }
            this.service
                .getCharacteristic(Characteristic.CurrentDoorState)
                .updateValue(1);
            this.service
                .getCharacteristic(Characteristic.TargetDoorState)
                .updateValue(1);
        }

        return [this.informationService, this.service];
    }
}

GarageDoorOpener.instances = instances;

module.exports = GarageDoorOpener;
