// HAP Door State Konstanten – werden auch von garageDoorOpener.js importiert
const DOOR_STATE = {
    OPEN: 0,
    CLOSED: 1,
    OPENING: 2,
    CLOSING: 3,
    STOPPED: 4,
};

/**
 * DoorStateManager kapselt den gesamten Zustandsautomaten des Garagentors:
 * - Bewegungs-Simulation (simulateOpen / simulateClose)
 * - autoClose-Timer
 * - Webhook-Zustandslogik (_processWebhookState)
 * - deCONZ-Endzustand-Synchronisation (syncFinalState)
 *
 * Die Klasse schreibt direkt in den übergebenen HAP-Service zurück,
 * kommuniziert aber über den onStatusRefresh-Callback nach oben zu
 * GarageDoorOpener (z. B. für Polling nach abgeschlossener Bewegung).
 */
class DoorStateManager {
    /**
     * @param {object} options
     * @param {Function}  options.log              Homebridge-Logger
     * @param {object}    options.service           HAP GarageDoorOpener-Service
     * @param {object}    options.Characteristic    HAP-Characteristic-Referenz
     * @param {boolean}   options.debug
     * @param {number}    options.openTime          Sekunden bis Tür vollständig offen
     * @param {number}    options.closeTime         Sekunden bis Tür vollständig geschlossen
     * @param {boolean}   options.autoClose         autoClose-Feature aktiv?
     * @param {number}    options.autoCloseDelay    Sekunden bis autoClose auslöst
     * @param {boolean}   options.polling           Polling aktiv? (beeinflusst autoClose-Logik)
     * @param {Function}  options.onStatusRefresh   Callback → GarageDoorOpener._getStatus
     */
    constructor(options) {
        this.log = options.log;
        this.service = options.service;
        this.Characteristic = options.Characteristic;
        this.debug = options.debug || false;
        this.openTime = options.openTime;
        this.closeTime = options.closeTime;
        this.autoClose = options.autoClose || false;
        this.autoCloseDelay = options.autoCloseDelay || 3600;
        this.polling = options.polling || false;
        this.onStatusRefresh = options.onStatusRefresh || (() => {});

        // Interner Zustand
        this.movementTimeout = null;
        this.autoCloseTimer = null;
        this.ignoreDeconzOpen = false;
        this._webhookDebounceTimer = null;
    }

    // -------------------------------------------------------------------------
    // Öffentliche Zustandsabfrage
    // -------------------------------------------------------------------------

    getCurrentDoorState() {
        return this.service.getCharacteristic(this.Characteristic.CurrentDoorState).value;
    }

    // -------------------------------------------------------------------------
    // Bewegungs-Simulation
    // -------------------------------------------------------------------------

    simulateOpen() {
        if (this.debug) {
            this.log('simulateOpen called');
        }
        if (this.movementTimeout) {
            clearTimeout(this.movementTimeout);
        }
        this.ignoreDeconzOpen = true;
        this.service
            .getCharacteristic(this.Characteristic.CurrentDoorState)
            .updateValue(DOOR_STATE.OPENING);
        this.movementTimeout = setTimeout(() => {
            this.ignoreDeconzOpen = false;
            this.movementTimeout = null;
            this.onStatusRefresh(() => {});
            this.log('Finished opening');
        }, this.openTime * 1000);
    }

    simulateClose() {
        if (this.debug) {
            this.log('simulateClose called');
        }
        this._cancelAutoClose();
        if (this.movementTimeout) {
            clearTimeout(this.movementTimeout);
        }
        this.ignoreDeconzOpen = false;
        this.service
            .getCharacteristic(this.Characteristic.CurrentDoorState)
            .updateValue(DOOR_STATE.CLOSING);
        this.movementTimeout = setTimeout(() => {
            this.movementTimeout = null;
            this.onStatusRefresh(() => {});
            this.log('Finished closing');
        }, this.closeTime * 1000);
    }

    // -------------------------------------------------------------------------
    // autoClose-Timer
    // -------------------------------------------------------------------------

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
                    this.service.setCharacteristic(this.Characteristic.TargetDoorState, DOOR_STATE.CLOSED);
                } else {
                    this.log('Auto-close: door already closed, nothing to do');
                }
            };
            if (this.polling) {
                // Frischen Status holen, dann entscheiden.
                // Second argument is `true` when the request was skipped (still in flight);
                // in that case we still run execute() because the cached state is recent.
                this.onStatusRefresh((_err, skipped) => {
                    if (_err && !skipped) {
                        this.log.warn('Auto-close: could not refresh status, skipping');
                        return;
                    }
                    execute();
                });
            } else {
                // Ohne Polling konservativ direkt schließen
                execute();
            }
        }, this.autoCloseDelay * 1000);
    }

    _cancelAutoClose() {
        if (this.autoCloseTimer) {
            clearTimeout(this.autoCloseTimer);
            this.autoCloseTimer = null;
            if (this.debug) {
                this.log('Auto-close timer cancelled');
            }
        }
    }

    // -------------------------------------------------------------------------
    // Webhook-Zustandslogik
    // -------------------------------------------------------------------------

    /**
     * Einstiegspunkt für eingehende Webhook-Signale.
     * Debounced rapidfolgende Aufrufe (z. B. Kontaktsensor-Prellen).
     *
     * @param {boolean} polling        Ob Polling aktiv ist (für initialen Status-Fetch)
     * @param {string|null} statusURL  Falls gesetzt, wird bei unbekanntem Zustand erst
     *                                 onStatusRefresh aufgerufen bevor die Logik greift.
     */
    handleWebhook(polling, statusURL) {
        // Debounce: nur den letzten Aufruf innerhalb von 300 ms verarbeiten
        if (this._webhookDebounceTimer) {
            clearTimeout(this._webhookDebounceTimer);
        }
        this._webhookDebounceTimer = setTimeout(() => {
            this._webhookDebounceTimer = null;
            this._handleWebhookDebounced(polling, statusURL);
        }, 300);
    }

    _handleWebhookDebounced(polling, statusURL) {
        const currentState = this.getCurrentDoorState();
        const targetState = this.service.getCharacteristic(this.Characteristic.TargetDoorState).value;
        if (this.debug) {
            this.log('Webhook received, currentState: %s, targetState: %s', currentState, targetState);
        }

        // Wenn Polling deaktiviert und der initiale Status noch unbekannt ist (null),
        // erst einen frischen Status holen bevor die Webhook-Logik greift
        if (!polling && statusURL && currentState === null) {
            if (this.debug) {
                this.log('Webhook: initial state unknown, fetching status first');
            }
            this.onStatusRefresh(() => this._processWebhookState());
            return;
        }

        this._processWebhookState();
    }

    _processWebhookState() {
        // Snapshot beider Werte vor jedem updateValue-Aufruf, um Race Conditions
        // durch ein bereits mutiertes targetState zu vermeiden.
        const currentState = this.getCurrentDoorState();
        const targetState = this.service.getCharacteristic(this.Characteristic.TargetDoorState).value;
        try {
            switch (currentState) {
                case DOOR_STATE.CLOSED: // Geschlossen → Öffnen starten
                    this.log('Started opening');
                    this.service
                        .getCharacteristic(this.Characteristic.TargetDoorState)
                        .updateValue(DOOR_STATE.OPEN);
                    this.simulateOpen();
                    if (this.autoClose) {
                        this._scheduleAutoClose();
                    }
                    break;
                case DOOR_STATE.OPEN: // Offen → Schließen starten
                    this.log('Started closing');
                    this.service
                        .getCharacteristic(this.Characteristic.TargetDoorState)
                        .updateValue(DOOR_STATE.CLOSED);
                    this.simulateClose();
                    break;
                case DOOR_STATE.OPENING: // Öffnet → stoppen
                case DOOR_STATE.CLOSING: // Schließt → stoppen
                    this.log('Stopping movement');
                    if (this.movementTimeout) {
                        clearTimeout(this.movementTimeout);
                        this.movementTimeout = null;
                    }
                    this.service
                        .getCharacteristic(this.Characteristic.CurrentDoorState)
                        .updateValue(DOOR_STATE.STOPPED);
                    break;
                case DOOR_STATE.STOPPED: // Gestoppt → Richtung umkehren
                    if (targetState === DOOR_STATE.OPEN) {
                        this.log('Reversing to close');
                        this.service
                            .getCharacteristic(this.Characteristic.TargetDoorState)
                            .updateValue(DOOR_STATE.CLOSED);
                        this.simulateClose();
                    } else {
                        this.log('Reversing to open');
                        this.service
                            .getCharacteristic(this.Characteristic.TargetDoorState)
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

    // -------------------------------------------------------------------------
    // deCONZ – Endzustand synchronisieren
    // -------------------------------------------------------------------------

    /**
     * Wird vom deCONZ-Listener aufgerufen, wenn ein echter Sensorwert eintrifft.
     * Bricht ggf. laufende Bewegungs-Simulation ab und setzt den echten Zustand.
     *
     * @param {{ open: boolean }} state  deCONZ-State-Objekt
     */
    handleDeconzState(state) {
        if (typeof state.open === 'undefined') {
            return;
        }

        if (state.open && this.ignoreDeconzOpen) {
            if (this.debug) {
                this.log('Ignoring deCONZ open event while opening');
            }
            return;
        }

        // Laufenden Schließ-Timer stoppen, wenn echter Closed-Event eintrifft
        if (!state.open && this.movementTimeout && this.getCurrentDoorState() === DOOR_STATE.CLOSING) {
            clearTimeout(this.movementTimeout);
            this.movementTimeout = null;
        }

        this.ignoreDeconzOpen = false;
        this.syncFinalState(state.open ? DOOR_STATE.OPEN : DOOR_STATE.CLOSED);

        if (state.open) {
            if (this.autoClose) {
                this._scheduleAutoClose();
            }
        } else {
            this._cancelAutoClose();
        }

        if (this.debug) {
            this.log('Updated door state from deCONZ to: %s', state.open ? DOOR_STATE.OPEN : DOOR_STATE.CLOSED);
        }
    }

    /**
     * Setzt CurrentDoorState sofort und TargetDoorState mit 20 ms Verzögerung,
     * damit iOS zwei getrennte Events erhält.
     *
     * @param {number} finalCurrent  HAP CurrentDoorState-Wert (0 = OPEN, 1 = CLOSED)
     */
    syncFinalState(finalCurrent) {
        const { CurrentDoorState, TargetDoorState } = this.Characteristic;

        // 1) Current sofort setzen
        this.service.updateCharacteristic(CurrentDoorState, finalCurrent);

        // 2) Target nachziehen (nur 0/1)
        const targetWanted = (finalCurrent === CurrentDoorState.OPEN)
            ? TargetDoorState.OPEN
            : TargetDoorState.CLOSED;

        const tChar = this.service.getCharacteristic(TargetDoorState);
        if (tChar.value !== targetWanted) {
            // kleiner Delay, damit iOS zwei getrennte Events sieht
            setTimeout(() => tChar.updateValue(targetWanted), 20);
        }
    }

    // -------------------------------------------------------------------------
    // Aufräumen
    // -------------------------------------------------------------------------

    /**
     * Stoppt alle laufenden Timer. Muss beim Shutdown aufgerufen werden.
     */
    destroy() {
        if (this.movementTimeout) {
            clearTimeout(this.movementTimeout);
            this.movementTimeout = null;
        }
        this._cancelAutoClose();
        if (this._webhookDebounceTimer) {
            clearTimeout(this._webhookDebounceTimer);
            this._webhookDebounceTimer = null;
        }
    }
}

module.exports = { DoorStateManager, DOOR_STATE };
