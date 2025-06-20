var Service, Characteristic;
const packageJson = require("./package.json");
const request = require("request");
const jp = require("jsonpath");
const http = require("http");

const instances = [];

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory(
        "homebridge-garage-door-shelly1",
        "GarageDoorOpener",
        GarageDoorOpener
    );

    homebridge.on("didFinishLaunching", () => {
        instances.forEach(instance => {
            if (typeof instance.startWebhookServer === "function") {
                instance.startWebhookServer();
                instance._getStatus(function() {});
            }
        });
    });

    homebridge.on("shutdown", () => {
        instances.forEach(instance => {
            if (typeof instance.stopWebhookServer === "function") {
                instance.stopWebhookServer();
            }
        });
    });
};

function GarageDoorOpener(log, config) {
    this.log = log;
    this.config = config;

    this.name = config.name;

    this.openURL = config.openURL;
    this.closeURL = config.closeURL;

    this.openTime = config.openTime || 10;
    this.closeTime = config.closeTime || 10;

    this.switchOff = config.switchOff || false;
    this.switchOffDelay = config.switchOffDelay || 2;

    this.autoLock = config.autoLock || false;
    this.autoLockDelay = config.autoLockDelay || 20;

    this.manufacturer = config.manufacturer || packageJson.author.name;
    this.serial = config.serial || packageJson.version;
    this.model = config.model || packageJson.name;
    this.firmware = config.firmware || packageJson.version;

    this.username = config.username || null;
    this.password = config.password || null;
    this.timeout = config.timeout || 3000;

    this.webhookPort = config.webhookPort || null;

    this.http_method = config.http_method || "GET";

    this.polling = config.polling || false;
    this.pollInterval = config.pollInterval || 120;

    this.statusURL = config.statusURL;
    this.statusKey = config.statusKey || "$.inputs[0].input";

    this.statusValueOpen = config.statusValueOpen || "0";
    this.statusValueClosed = config.statusValueClosed || "1";
    this.statusValueOpening = config.statusValueOpening || "2";
    this.statusValueClosing = config.statusValueClosing || "3";

    if (this.username != null && this.password != null) {
        this.auth = {
            user: this.username,
            pass: this.password,
        };
    }

    this.service = new Service.GarageDoorOpener(this.name);

    this.movementTimeout = null;

    instances.push(this);
}

GarageDoorOpener.prototype = {
    identify: function(callback) {
        this.log("Identify requested!");
        callback();
    },

    _httpRequest: function(url, body, method, callback) {
        if (this.config.debug) {
            this.log(
                "HTTP request -> method: %s, url: %s, body: %s",
                this.http_method,
                url,
                body
            );
        }

        request(
            {
                url: url,
                body: body,
                method: this.http_method,
                timeout: this.timeout,
                rejectUnauthorized: false,
                auth: this.auth,
            },
            function(error, response, body) {
                if (this.config.debug) {
                    if (error) {
                        this.log("HTTP request error: %s", error.message);
                    } else {
                        // this.log(
                        //     "HTTP response -> status: %s, body: %s",
                        //     response && response.statusCode,
                        //     body
                        // );
                    }
                }
                callback(error, response, body);
            }.bind(this)
        );
    },

    _getStatus: function(callback) {
        var url = this.statusURL;

        if (this.config.debug) {
            this.log("Getting status: %s", url);
        }

        this._httpRequest(
            url,
            "",
            "GET",
            function(error, response, responseBody) {
                if (error) {
                    this.log.error("Error getting status: %s", error.message);
                    this.service
                        .getCharacteristic(Characteristic.CurrentDoorState)
                        .updateValue(new Error("Polling failed"));
                    callback(error);
                } else {
                    if (this.config.debug) {
                        // this.log(
                        //     "Status response -> status: %s, body: %s",
                        //     response && response.statusCode,
                        //     responseBody
                        // );
                    }
                    let statusValue = 0;

                    if (this.statusKey) {
                        var originalStatusValue = jp
                            .query(
                                typeof responseBody === "string" ?
                                JSON.parse(responseBody) :
                                responseBody,
                                this.statusKey,
                                1
                            )
                            .pop();

                        if (new RegExp(this.statusValueOpen).test(originalStatusValue)) {
                            statusValue = 0;
                        } else if (
                            new RegExp(this.statusValueClosed).test(originalStatusValue)
                        ) {
                            statusValue = 1;
                        } else if (
                            new RegExp(this.statusValueOpening).test(originalStatusValue)
                        ) {
                            statusValue = 2;
                        } else if (
                            new RegExp(this.statusValueClosing).test(originalStatusValue)
                        ) {
                            statusValue = 3;
                        }

                        if (this.config.debug) {
                            this.log(
                                "Transformed status value from %s to %s (%s)",
                                originalStatusValue,
                                statusValue,
                                this.statusKey
                            );
                        }
                    } else {
                        statusValue = responseBody;
                    }
                    this.service
                        .getCharacteristic(Characteristic.CurrentDoorState)
                        .updateValue(statusValue);
                    this.service
                        .getCharacteristic(Characteristic.TargetDoorState)
                        .updateValue(statusValue);

                    if (this.config.debug) {
                        this.log("Updated door state to: %s", statusValue);
                    }

                    callback();
                }
            }.bind(this)
        );
    },

    setTargetDoorState: function(value, callback) {
        var url;

        this.log("Setting targetDoorState to %s", value);

        if (value === 1) {
            url = this.closeURL;
        } else {
            url = this.openURL;
        }

        if (this.config.debug) {
            this.log("Requesting URL: %s", url);
        }

        this._httpRequest(
            url,
            "",
            this.http_method,
            function(error, response, responseBody) {
                if (error) {
                    this.log.warn("Error setting targetDoorState: %s", error.message);
                    callback(error);
                } else {
                    if (value === 1) {
                    } else {
                        if (this.switchOff) {
                            this.switchOffFunction();
                        }
                        if (this.autoLock) {
                            this.autoLockFunction();
                        }
                    }
                    callback();
                }
            }.bind(this)
        );
    },

    getCurrentDoorState: function() {
        return this.service.getCharacteristic(
            Characteristic.CurrentDoorState
        ).value;
    },

    simulateOpen: function() {
        if (this.config.debug) {
            this.log("simulateOpen called");
        }
        if (this.movementTimeout) {
            clearTimeout(this.movementTimeout);
        }
        this.service
            .getCharacteristic(Characteristic.CurrentDoorState)
            .updateValue(2);
        this.movementTimeout = setTimeout(() => {
            this.movementTimeout = null;
            this._getStatus(function() {});
            this.log("Finished opening");
        }, this.openTime * 1000);
    },

    simulateClose: function() {
        if (this.config.debug) {
            this.log("simulateClose called");
        }
        if (this.movementTimeout) {
            clearTimeout(this.movementTimeout);
        }
        this.service
            .getCharacteristic(Characteristic.CurrentDoorState)
            .updateValue(3);
        this.movementTimeout = setTimeout(() => {
            this.movementTimeout = null;
            this._getStatus(function() {});
            this.log("Finished closing");
        }, this.closeTime * 1000);
    },

    autoLockFunction: function() {
        if (this.config.debug) {
            this.log("autoLockFunction called");
        }
        this.log("Waiting %s seconds for autolock", this.autoLockDelay);
        setTimeout(() => {
            this.service.setCharacteristic(Characteristic.TargetDoorState, 1);
            this.log("Autolocking...");
        }, this.autoLockDelay * 1000);
    },

    switchOffFunction: function() {
        if (this.config.debug) {
            this.log("switchOffFunction called");
        }
        this.log("Waiting %s seconds for switch off", this.switchOffDelay);
        setTimeout(() => {
            this.log("SwitchOff...");
            this._httpRequest(
                this.closeURL,
                "",
                this.http_method,
                function(error, response, responseBody) {}.bind(this)
            );
        }, this.switchOffDelay * 1000);
    },

    handleWebhook: function() {
        const currentState = this.getCurrentDoorState();
        const targetState = this.service.getCharacteristic(
            Characteristic.TargetDoorState
        ).value;

        if (this.config.debug) {
            this.log(
                "Webhook received, currentState: %s, targetState: %s",
                currentState,
                targetState
            );
        }

        try {
            switch (currentState) {
                case 1: // Closed -> start opening
                    this.log("Started opening");
                    this.service
                        .getCharacteristic(Characteristic.TargetDoorState)
                        .updateValue(0);
                    this.simulateOpen();
                    break;
                case 0: // Open -> start closing
                    this.log("Started closing");
                    this.service
                        .getCharacteristic(Characteristic.TargetDoorState)
                        .updateValue(1);
                    this.simulateClose();
                    break;
                case 2: // Opening -> stop
                case 3: // Closing -> stop
                    this.log("Stopping movement");
                    this.service
                        .getCharacteristic(Characteristic.CurrentDoorState)
                        .updateValue(4);
                    break;
                case 4: // Stopped -> reverse direction
                    if (targetState === 0) {
                        this.log("Reversing to close");
                        this.service
                            .getCharacteristic(Characteristic.TargetDoorState)
                            .updateValue(1);
                        this.simulateClose();
                    } else {
                        this.log("Reversing to open");
                        this.service
                            .getCharacteristic(Characteristic.TargetDoorState)
                            .updateValue(0);
                        this.simulateOpen();
                    }
                    break;
            }
        } catch (err) {
            this.log.error("Failed to handle webhook: %s", err.message);
        }
    },

    startWebhookServer: function() {
        if (!this.webhookPort) {
            return;
        }

        try {
            if (this.config.debug) {
                this.log(
                    "Starting webhook server on port %s",
                    this.webhookPort
                );
            }
            this.server = http.createServer((req, res) => {
                if (this.config.debug) {
                    this.log(
                        "Webhook request: %s %s",
                        req.method,
                        req.url
                    );
                }
                try {
                    if (req.url === "/garage/update") {
                        this.handleWebhook();
                        res.statusCode = 200;
                        res.end("OK");
                    } else {
                        res.statusCode = 404;
                        res.end();
                    }
                } catch (err) {
                    this.log.error("Webhook handler error: %s", err.message);
                    res.statusCode = 500;
                    res.end();
                }
            });

            this.server.on("error", err => {
                this.log.error("Webhook server error: %s", err.message);
            });

            this.server.listen(this.webhookPort, () => {
                this.log("Webhook server listening on port %s", this.webhookPort);
            });
        } catch (err) {
            this.log.error("Failed to start webhook server: %s", err.message);
        }
    },

    stopWebhookServer: function() {
        if (this.server) {
            try {
                if (this.config.debug) {
                    this.log(
                        "Stopping webhook server on port %s",
                        this.webhookPort
                    );
                }
                this.server.close();
                this.log("Webhook server on port %s stopped", this.webhookPort);
            } catch (err) {
                this.log.error("Error stopping webhook server: %s", err.message);
            }
        }
    },

    getServices: function() {
        if (this.config.debug) {
            this.log("Initializing services");
        }
        this.informationService = new Service.AccessoryInformation();

        this.informationService
            .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
            .setCharacteristic(Characteristic.Model, this.model)
            .setCharacteristic(Characteristic.SerialNumber, this.serial)
            .setCharacteristic(Characteristic.FirmwareRevision, this.firmware);

        this.service
            .getCharacteristic(Characteristic.TargetDoorState)
            .on("set", this.setTargetDoorState.bind(this));

        if (this.polling) {
            if (this.config.debug) {
                this.log(
                    "Polling enabled with interval %s seconds",
                    this.pollInterval
                );
            }
            this._getStatus(function() {});

            setInterval(
                function() {
                    this._getStatus(function() {});
                }.bind(this),
                this.pollInterval * 1000
            );
        } else {
            if (this.config.debug) {
                this.log("Polling disabled");
            }
            this.service
                .getCharacteristic(Characteristic.CurrentDoorState)
                .updateValue(1);

            this.service
                .getCharacteristic(Characteristic.TargetDoorState)
                .updateValue(1);
        }

        return [this.informationService, this.service];
    },
};