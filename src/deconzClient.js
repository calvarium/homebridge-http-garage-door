const WebSocket = require('ws');

class DeconzClient {
    constructor(log, options = {}) {
        this.log = log;
        this.host = options.host || 'localhost';
        this.port = options.port || 443;
        this.deviceId = options.deviceId;
        this.debug = options.debug;
        this.ws = null;
        this.connected = false;
        this.onEvent = null;
        this._destroyed = false;
    }

    connect(onEvent) {
        this.onEvent = onEvent;
        this._destroyed = false;
        const url = `ws://${this.host}:${this.port}`;
        const connectWebSocket = () => {
            if (this._destroyed) {
                return;
            }
            if (this.debug) {
                this.log(`Connecting to deCONZ websocket at ${url}`);
            }
            this.ws = new WebSocket(url);

            this.ws.on('open', () => {
                this.connected = true;
                if (this.debug) {
                    this.log(`deCONZ websocket connected to ${url}`);
                }
            });

            this.ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (this.debug) {
                        this.log(`deCONZ websocket message: ${data}`);
                    }
                    if (
                        msg.e === 'changed' &&
                        msg.r === 'sensors' &&
                        String(msg.id) === String(this.deviceId) &&
                        msg.state
                    ) {
                        if (typeof this.onEvent === 'function') {
                            this.onEvent(msg.state);
                        }
                    }
                } catch (err) {
                    this.log.error(`deCONZ websocket parse error: ${err.message}`);
                }
            });

            this.ws.on('close', () => {
                this.connected = false;
                if (this.debug) {
                    this.log(`deCONZ websocket disconnected from ${url}`);
                }
                if (!this._destroyed) {
                    setTimeout(connectWebSocket, 10000);
                }
            });

            this.ws.on('error', (err) => {
                this.log.error(`deCONZ websocket error: ${err.message}`);
            });
        };

        connectWebSocket();
    }

    close() {
        this._destroyed = true;
        if (this.ws) {
            this.connected = false;
            this.ws.close();
            this.ws = null;
        }
    }
}

module.exports = DeconzClient;
