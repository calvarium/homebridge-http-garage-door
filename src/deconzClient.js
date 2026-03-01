const WebSocket = require('ws');

// Reconnect timing constants
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 60000;

class DeconzClient {
    constructor(log, options = {}) {
        this.log = log;
        this.host = options.host || 'localhost';
        this.port = options.port || 80;
        this.deviceId = options.deviceId;
        this.debug = options.debug;
        this.ws = null;
        this._destroyed = false;
        this._reconnectTimer = null;
        this._reconnectDelay = RECONNECT_BASE_DELAY_MS;
    }

    connect(onEvent) {
        this._destroyed = false;
        this._reconnectDelay = RECONNECT_BASE_DELAY_MS;

        // Use wss:// for port 443 (standard HTTPS/WSS port), ws:// otherwise.
        const scheme = this.port === 443 ? 'wss' : 'ws';
        const url = `${scheme}://${this.host}:${this.port}`;

        const connectWebSocket = () => {
            if (this._destroyed) {
                return;
            }
            if (this.debug) {
                this.log(`Connecting to deCONZ websocket at ${url}`);
            }
            this.ws = new WebSocket(url);

            this.ws.on('open', () => {
                // Reset backoff on successful connection
                this._reconnectDelay = RECONNECT_BASE_DELAY_MS;
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
                        onEvent(msg.state);
                    }
                } catch (err) {
                    this.log.error(`deCONZ websocket parse error: ${err.message}`);
                }
            });

            this.ws.on('close', () => {
                if (this.debug) {
                    this.log(`deCONZ websocket disconnected from ${url}`);
                }
                if (!this._destroyed) {
                    if (this.debug) {
                        this.log(`deCONZ reconnecting in ${this._reconnectDelay}ms`);
                    }
                    this._reconnectTimer = setTimeout(() => {
                        this._reconnectTimer = null;
                        connectWebSocket();
                    }, this._reconnectDelay);
                    // Exponential backoff, capped at max delay
                    this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
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
        // Cancel any pending reconnect timer so no new connection attempt is started
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

module.exports = DeconzClient;
