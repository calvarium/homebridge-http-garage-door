const packageJson = require('../package.json');
const HttpClient = require('./httpClient');
const WebhookServer = require('./webhookServer');
const DeconzClient = require('./deconzClient');
const { DoorStateManager, DOOR_STATE } = require('./doorStateManager');

let Service;
let Characteristic;

class GarageDoorOpener {
    static instances = [];

    constructor(log, config) {
        // --- Pflichtfeld-Validierung ---
        if (!config.name) {
            throw new Error('[GarageDoorOpener] config.name is required');
        }
        if (!config.openURL) {
            throw new Error('[GarageDoorOpener] config.openURL is required');
        }
        if (!config.closeURL) {
            throw new Error('[GarageDoorOpener] config.closeURL is required');
        }

        this.log = log;

        // Alle Config-Werte werden vollständig auf this.* extrahiert;
        // this.config wird nicht mehr als Rohobjekt-Referenz weitergegeben.
        this.name = config.name;
        this.debug = config.debug || false;
        this.openURL = config.openURL;
        this.closeURL = config.closeURL;
        this.openTime = config.openTime || 10;
        this.closeTime = config.closeTime || 10;
        this.switchOff = config.switchOff || false;
        this.switchOffDelay = config.switchOffDelay || 2;
        this.switchOffURL = config.switchOffURL || config.openURL;
        this.autoClose = config.autoClose || false;
        this.autoCloseDelay = config.autoCloseDelay || 3600;
        this.manufacturer = config.manufacturer || (typeof packageJson.author === 'string' ? packageJson.author : packageJson.author.name);
        this.serial = config.serial || packageJson.version;
        this.model = config.model || packageJson.name;
        this.firmware = config.firmware || packageJson.version;
        this.username = config.username || null;
        this.password = config.password || null;
        this.timeout = config.timeout || 3000;
        this.webhookPort = config.webhookPort || null;
        this.webhookPath = config.webhookPath || '/garage/update';
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

        // Ob mindestens ein Sensor-Feedback-Kanal konfiguriert ist.
        // Entscheidet, ob setTargetDoorState die Simulation selbst startet.
        this.hasSensorFeedback = !!(this.webhookPort || this.deconzDeviceId);

        // Regex-Ausdrücke vorab kompilieren und auf Gültigkeit prüfen,
        // damit Konfigurationsfehler früh (beim Start) sichtbar werden.
        this.statusRegexOpen = this._compileRegex(this.statusValueOpen, 'statusValueOpen');
        this.statusRegexClosed = this._compileRegex(this.statusValueClosed, 'statusValueClosed');
        this.statusRegexOpening = this._compileRegex(this.statusValueOpening, 'statusValueOpening');
        this.statusRegexClosing = this._compileRegex(this.statusValueClosing, 'statusValueClosing');

        if (this.username != null && this.password != null) {
            this.auth = { user: this.username, pass: this.password };
        }

        this.httpClient = new HttpClient(this.log, {
            debug: this.debug,
            httpMethod: this.httpMethod,
            timeout: this.timeout,
            auth: this.auth,
            rejectUnauthorized: this.rejectUnauthorized,
        });

        this.service = new Service.GarageDoorOpener(this.name);
        this.informationService = null;
        this.pollIntervalHandle = null;
        this._statusPending = false;

        // Zustandsautomat – verwaltet alle Timer und Bewegungslogik
        this.stateManager = new DoorStateManager({
            log: this.log,
            service: this.service,
            Characteristic,
            debug: this.debug,
            openTime: this.openTime,
            closeTime: this.closeTime,
            autoClose: this.autoClose,
            autoCloseDelay: this.autoCloseDelay,
            polling: this.polling,
            onStatusRefresh: (cb) => this._getStatus(cb),
        });

        if (this.webhookPort) {
            this.webhookServer = new WebhookServer(
                this.log,
                this.webhookPort,
                this.debug,
                this.webhookPath,
                () => this.stateManager.handleWebhook(this.polling, this.statusURL),
            );
        }

        if (this.deconzDeviceId) {
            this.deconzClient = new DeconzClient(this.log, {
                host: this.deconzHost,
                port: this.deconzPort,
                deviceId: this.deconzDeviceId,
                debug: this.debug,
            });
        }

        GarageDoorOpener.instances.push(this);
    }

    /**
     * Kompiliert einen RegExp-String und gibt eine RegExp-Instanz zurück.
     * Wirft einen aussagekräftigen Fehler, wenn der Ausdruck ungültig ist.
     * @param {string} pattern
     * @param {string} configKey  Name des Config-Feldes (für Fehlermeldung)
     * @returns {RegExp}
     */
    _compileRegex(pattern, configKey) {
        try {
            return new RegExp(pattern);
        } catch (err) {
            throw new Error(`[GarageDoorOpener] Invalid regex in config.${configKey}: "${pattern}" — ${err.message}`);
        }
    }

    static configure(service, characteristic) {
        Service = service;
        Characteristic = characteristic;
    }

    identify(callback) {
        this.log('Identify requested!');
        callback();
    }

    // -------------------------------------------------------------------------
    // Status-Abfrage (HTTP-Polling)
    // -------------------------------------------------------------------------

    _getStatus(callback) {
        if (this._statusPending) {
            if (this.debug) {
                this.log('_getStatus skipped: previous request still in flight');
            }
            // Sentinel: zweites Argument `true` signalisiert "übersprungen"
            callback(null, /* skipped */ true);
            return;
        }
        this._statusPending = true;
        this.httpClient.getStatus(
            this.statusURL,
            this.statusKey,
            {
                open: this.statusRegexOpen,
                closed: this.statusRegexClosed,
                opening: this.statusRegexOpening,
                closing: this.statusRegexClosing,
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
                    if (!this.stateManager.movementTimeout) {
                        this.service
                            .getCharacteristic(Characteristic.TargetDoorState)
                            .updateValue(statusValue <= DOOR_STATE.CLOSED ? statusValue : DOOR_STATE.OPEN);
                    }
                    if (this.debug) {
                        this.log('Updated door state to: %s', statusValue);
                    }
                    callback();
                }
            },
        );
    }

    // -------------------------------------------------------------------------
    // Steuerung (HAP-Set-Handler)
    // -------------------------------------------------------------------------

    setTargetDoorState(value, callback) {
        const url = value === DOOR_STATE.CLOSED ? this.closeURL : this.openURL;
        this.log('Setting targetDoorState to %s', value);
        if (this.debug) {
            this.log('Requesting URL: %s', url);
        }
        this.httpClient.request(url, '', this.httpMethod, (error) => {
            if (error) {
                this.log.warn('Error setting targetDoorState: %s', error.message);
                callback(error);
                return;
            }
            // Im Sensor-Modus (webhookPort oder deconzDeviceId konfiguriert) kommt
            // der Bewegungsstart über den Sensor-Callback (handleWebhook /
            // handleDeconzState). setTargetDoorState sendet hier nur den HTTP-Request
            // und überlässt die Simulation dem Sensor-Pfad — sonst würde ein
            // eingehender Webhook den Zustand OPENING sehen und sofort stoppen.
            //
            // Ohne Sensor (reiner HTTP-Modus) gibt es keinen Rückkanal, daher
            // starten wir die Simulation hier selbst.
            if (!this.hasSensorFeedback) {
                if (value === DOOR_STATE.CLOSED) {
                    this.stateManager.simulateClose();
                } else {
                    this.stateManager.simulateOpen();
                    if (this.switchOff) {
                        this._switchOffFunction();
                    }
                    if (this.autoClose) {
                        this.stateManager._scheduleAutoClose();
                    }
                }
            }
            callback();
        });
    }

    // -------------------------------------------------------------------------
    // Hilfs-Methode: Relay nach Öffnen ausschalten
    // -------------------------------------------------------------------------

    _switchOffFunction() {
        if (this.debug) {
            this.log('_switchOffFunction called');
        }
        this.log('Waiting %s seconds for switch off', this.switchOffDelay);
        setTimeout(() => {
            this.log('SwitchOff...');
            this.httpClient.request(this.switchOffURL, '', this.httpMethod, () => {});
        }, this.switchOffDelay * 1000);
    }

    // -------------------------------------------------------------------------
    // Lifecycle: start / stop
    // -------------------------------------------------------------------------

    /**
     * Startet alle aktiven Listener und holt den initialen Status.
     * Wird von index.js im didFinishLaunching-Event aufgerufen.
     */
    start() {
        this.startWebhookServer();
        this._getStatus(() => {});
        this.startDeconzListener();
    }

    startWebhookServer() {
        if (this.webhookServer) {
            this.webhookServer.start();
        }
    }

    startDeconzListener() {
        if (this.deconzClient) {
            this.deconzClient.connect((state) => this.stateManager.handleDeconzState(state));
        }
    }

    stopPolling() {
        if (this.pollIntervalHandle) {
            clearInterval(this.pollIntervalHandle);
            this.pollIntervalHandle = null;
            if (this.debug) {
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

    /**
     * Entfernt diese Instanz aus dem statischen instances-Array.
     * Muss beim Shutdown aufgerufen werden, um einen Memory Leak zu vermeiden.
     */
    _unregisterInstance() {
        GarageDoorOpener.instances = GarageDoorOpener.instances.filter(i => i !== this);
    }

    // -------------------------------------------------------------------------
    // HAP-Service-Registrierung
    // -------------------------------------------------------------------------

    getServices() {
        if (this.debug) {
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
            if (this.debug) {
                this.log('Polling enabled with interval %s seconds', this.pollInterval);
            }
            this.pollIntervalHandle = setInterval(() => {
                this._getStatus(() => {});
            }, this.pollInterval * 1000);
        } else {
            if (this.debug) {
                this.log('Polling disabled');
            }
            // Ohne statusURL sicher auf CLOSED initialisieren; den echten Status
            // holt start() via _getStatus beim didFinishLaunching-Event.
            if (!this.statusURL) {
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
