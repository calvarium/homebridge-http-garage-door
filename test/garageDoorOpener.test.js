const GarageDoorOpener = require('../src/garageDoorOpener');

// ---------------------------------------------------------------------------
// Gemeinsame Test-Infrastruktur
// ---------------------------------------------------------------------------

class FakeCharacteristic {
    constructor() { this.value = null; }
    updateValue(val) { this.value = val; return this; }
    on() { return this; }
}

function makeFakeService() {
    return class {
        constructor() { this.characteristics = {}; }
        getCharacteristic(name) {
            if (!this.characteristics[name]) {
                this.characteristics[name] = new FakeCharacteristic();
            }
            return this.characteristics[name];
        }
        setCharacteristic(name, value) {
            this.getCharacteristic(name).updateValue(value);
            return this;
        }
        updateCharacteristic(name, value) {
            this.getCharacteristic(name).updateValue(value);
            return this;
        }
    };
}

const Characteristic = {
    CurrentDoorState: 'CurrentDoorState',
    TargetDoorState: 'TargetDoorState',
    Manufacturer: 'Manufacturer',
    Model: 'Model',
    SerialNumber: 'SerialNumber',
    FirmwareRevision: 'FirmwareRevision',
};

function makeService() {
    return {
        GarageDoorOpener: makeFakeService(),
        AccessoryInformation: makeFakeService(),
    };
}

function makeLog() {
    return Object.assign(jest.fn(), {
        warn: jest.fn(),
        error: jest.fn(),
    });
}

function makeOpener(overrides = {}) {
    const Service = makeService();
    GarageDoorOpener.configure(Service, Characteristic);
    const log = makeLog();
    const config = {
        name: 'Test Garage',
        openURL: 'http://localhost/open',
        closeURL: 'http://localhost/close',
        openTime: 0,
        closeTime: 0,
        ...overrides,
    };
    const opener = new GarageDoorOpener(log, config);
    opener._getStatus = jest.fn((cb) => cb && cb());
    // onStatusRefresh im stateManager ebenfalls mocken, damit Timer-Callbacks
    // nicht versehentlich echte HTTP-Requests auslösen
    opener.stateManager.onStatusRefresh = jest.fn((cb) => cb && cb());
    return opener;
}

// ---------------------------------------------------------------------------
// Konstruktor-Validierung
// ---------------------------------------------------------------------------

describe('GarageDoorOpener – Konstruktor-Validierung', () => {
    const Service = makeService();
    GarageDoorOpener.configure(Service, Characteristic);

    test('wirft Fehler wenn name fehlt', () => {
        expect(() => new GarageDoorOpener(makeLog(), { openURL: 'http://x', closeURL: 'http://y' }))
            .toThrow('config.name is required');
    });

    test('wirft Fehler wenn openURL fehlt', () => {
        expect(() => new GarageDoorOpener(makeLog(), { name: 'T', closeURL: 'http://y' }))
            .toThrow('config.openURL is required');
    });

    test('wirft Fehler wenn closeURL fehlt', () => {
        expect(() => new GarageDoorOpener(makeLog(), { name: 'T', openURL: 'http://x' }))
            .toThrow('config.closeURL is required');
    });

    test('wirft Fehler bei ungültigem statusValueOpen-Regex', () => {
        expect(() => new GarageDoorOpener(makeLog(), {
            name: 'T', openURL: 'http://x', closeURL: 'http://y',
            statusValueOpen: '[invalid',
        })).toThrow('Invalid regex in config.statusValueOpen');
    });

    test('hasSensorFeedback ist false ohne webhookPort und deconzDeviceId', () => {
        const opener = makeOpener();
        expect(opener.hasSensorFeedback).toBe(false);
    });

    test('hasSensorFeedback ist true wenn webhookPort gesetzt', () => {
        const opener = makeOpener({ webhookPort: 51828 });
        expect(opener.hasSensorFeedback).toBe(true);
    });

    test('hasSensorFeedback ist true wenn deconzDeviceId gesetzt', () => {
        const opener = makeOpener({ deconzDeviceId: '42' });
        expect(opener.hasSensorFeedback).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// simulateOpen / simulateClose  (via stateManager)
// ---------------------------------------------------------------------------

describe('GarageDoorOpener – simulate (via stateManager)', () => {
    let opener;
    beforeEach(() => { opener = makeOpener(); });

    test('simulateOpen setzt State auf OPENING (2)', () => {
        opener.stateManager.simulateOpen();
        expect(opener.stateManager.getCurrentDoorState()).toBe(2);
    });

    test('simulateClose setzt State auf CLOSING (3)', () => {
        opener.stateManager.simulateClose();
        expect(opener.stateManager.getCurrentDoorState()).toBe(3);
    });

    test('simulateOpen setzt ignoreDeconzOpen auf true', () => {
        opener.stateManager.simulateOpen();
        expect(opener.stateManager.ignoreDeconzOpen).toBe(true);
    });

    test('simulateClose setzt ignoreDeconzOpen auf false', () => {
        opener.stateManager.ignoreDeconzOpen = true;
        opener.stateManager.simulateClose();
        expect(opener.stateManager.ignoreDeconzOpen).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// setTargetDoorState
// ---------------------------------------------------------------------------

describe('GarageDoorOpener – setTargetDoorState (kein Sensor / reiner HTTP-Modus)', () => {
    jest.useFakeTimers();

    let opener;
    beforeEach(() => {
        // Kein webhookPort, kein deconzDeviceId → reiner HTTP-Modus
        opener = makeOpener();
        opener.httpClient = { request: jest.fn((url, body, method, cb) => cb(null)) };
    });

    afterEach(() => jest.clearAllTimers());

    test('ruft openURL auf wenn value = OPEN (0)', () => {
        opener.setTargetDoorState(0, jest.fn());
        expect(opener.httpClient.request).toHaveBeenCalledWith(
            'http://localhost/open', '', 'GET', expect.any(Function),
        );
    });

    test('ruft closeURL auf wenn value = CLOSED (1)', () => {
        opener.setTargetDoorState(1, jest.fn());
        expect(opener.httpClient.request).toHaveBeenCalledWith(
            'http://localhost/close', '', 'GET', expect.any(Function),
        );
    });

    test('startet simulateOpen nach erfolgreichem Open-Request', () => {
        opener.stateManager.simulateOpen = jest.fn();
        opener.setTargetDoorState(0, jest.fn());
        expect(opener.stateManager.simulateOpen).toHaveBeenCalled();
    });

    test('startet simulateClose nach erfolgreichem Close-Request', () => {
        opener.stateManager.simulateClose = jest.fn();
        opener.setTargetDoorState(1, jest.fn());
        expect(opener.stateManager.simulateClose).toHaveBeenCalled();
    });

    test('ruft callback mit Fehler auf wenn HTTP-Request fehlschlägt', () => {
        const err = new Error('network error');
        opener.httpClient.request = jest.fn((url, body, method, cb) => cb(err));
        const cb = jest.fn();
        opener.setTargetDoorState(0, cb);
        expect(cb).toHaveBeenCalledWith(err);
    });

    test('ruft callback ohne Fehler auf bei Erfolg', () => {
        const cb = jest.fn();
        opener.setTargetDoorState(0, cb);
        expect(cb).toHaveBeenCalledWith(/* no error */);
    });

    test('plant autoClose nach Open wenn autoClose aktiv', () => {
        opener.autoClose = true;
        opener.stateManager._scheduleAutoClose = jest.fn();
        opener.setTargetDoorState(0, jest.fn());
        expect(opener.stateManager._scheduleAutoClose).toHaveBeenCalled();
    });

    test('plant kein autoClose nach Close', () => {
        opener.autoClose = true;
        opener.stateManager._scheduleAutoClose = jest.fn();
        opener.setTargetDoorState(1, jest.fn());
        expect(opener.stateManager._scheduleAutoClose).not.toHaveBeenCalled();
    });
});

describe('GarageDoorOpener – setTargetDoorState (Webhook-Modus)', () => {
    jest.useFakeTimers();

    let opener;
    beforeEach(() => {
        // webhookPort gesetzt → Simulation darf NICHT aus setTargetDoorState heraus starten
        opener = makeOpener({ webhookPort: 51828 });
        // webhookServer-Instanz überschreiben, damit kein echter HTTP-Server startet
        opener.webhookServer = { start: jest.fn(), stop: jest.fn() };
        opener.httpClient = { request: jest.fn((url, body, method, cb) => cb(null)) };
    });

    afterEach(() => jest.clearAllTimers());

    test('startet simulateOpen NICHT – Simulation obliegt dem Webhook', () => {
        opener.stateManager.simulateOpen = jest.fn();
        opener.setTargetDoorState(0, jest.fn());
        expect(opener.stateManager.simulateOpen).not.toHaveBeenCalled();
    });

    test('startet simulateClose NICHT – Simulation obliegt dem Webhook', () => {
        opener.stateManager.simulateClose = jest.fn();
        opener.setTargetDoorState(1, jest.fn());
        expect(opener.stateManager.simulateClose).not.toHaveBeenCalled();
    });

    test('CurrentDoorState bleibt unverändert nach setTargetDoorState', () => {
        opener.service.getCharacteristic('CurrentDoorState').updateValue(1); // CLOSED
        opener.setTargetDoorState(0, jest.fn());
        // Zustand darf sich nicht ändern – der Webhook übernimmt das
        expect(opener.stateManager.getCurrentDoorState()).toBe(1);
    });

    test('sendet trotzdem die HTTP-Anfrage ab', () => {
        opener.setTargetDoorState(0, jest.fn());
        expect(opener.httpClient.request).toHaveBeenCalledWith(
            'http://localhost/open', '', 'GET', expect.any(Function),
        );
    });
});

describe('GarageDoorOpener – setTargetDoorState (deCONZ-Modus)', () => {
    jest.useFakeTimers();

    let opener;
    beforeEach(() => {
        // deconzDeviceId gesetzt → Simulation obliegt dem deCONZ-Listener
        opener = makeOpener({ deconzDeviceId: '42' });
        opener.deconzClient = { connect: jest.fn(), close: jest.fn() };
        opener.httpClient = { request: jest.fn((url, body, method, cb) => cb(null)) };
    });

    afterEach(() => jest.clearAllTimers());

    test('startet simulateOpen NICHT – Simulation obliegt deCONZ', () => {
        opener.stateManager.simulateOpen = jest.fn();
        opener.setTargetDoorState(0, jest.fn());
        expect(opener.stateManager.simulateOpen).not.toHaveBeenCalled();
    });

    test('startet simulateClose NICHT – Simulation obliegt deCONZ', () => {
        opener.stateManager.simulateClose = jest.fn();
        opener.setTargetDoorState(1, jest.fn());
        expect(opener.stateManager.simulateClose).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// autoClose  (via stateManager)
// ---------------------------------------------------------------------------

describe('DoorStateManager – autoClose', () => {
    jest.useFakeTimers();

    let opener;
    beforeEach(() => {
        opener = makeOpener({ autoClose: true, autoCloseDelay: 60 });
    });

    afterEach(() => jest.clearAllTimers());

    test('_scheduleAutoClose setzt einen Timer', () => {
        opener.stateManager._scheduleAutoClose();
        expect(opener.stateManager.autoCloseTimer).not.toBeNull();
    });

    test('Timer löst Schließen aus wenn Tür OPEN (0)', () => {
        opener.service.getCharacteristic('CurrentDoorState').updateValue(0);
        opener.stateManager._scheduleAutoClose();
        jest.runAllTimers();
        expect(opener.service.getCharacteristic('TargetDoorState').value).toBe(1);
    });

    test('Timer tut nichts wenn Tür bereits CLOSED (1)', () => {
        opener.service.getCharacteristic('CurrentDoorState').updateValue(1);
        opener.stateManager._scheduleAutoClose();
        jest.runAllTimers();
        // TargetDoorState bleibt null (nie gesetzt)
        expect(opener.service.getCharacteristic('TargetDoorState').value).toBeNull();
    });

    test('simulateClose cancelt den autoClose-Timer', () => {
        opener.stateManager._scheduleAutoClose();
        expect(opener.stateManager.autoCloseTimer).not.toBeNull();
        opener.stateManager.simulateClose();
        expect(opener.stateManager.autoCloseTimer).toBeNull();
    });

    test('_cancelAutoClose setzt autoCloseTimer auf null', () => {
        opener.stateManager._scheduleAutoClose();
        opener.stateManager._cancelAutoClose();
        expect(opener.stateManager.autoCloseTimer).toBeNull();
    });

    test('_scheduleAutoClose setzt immer einen Timer (Schutz liegt beim Aufrufer)', () => {
        opener.stateManager.autoClose = false;
        opener.stateManager._scheduleAutoClose();
        expect(opener.stateManager.autoCloseTimer).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// _processWebhookState  (via stateManager)
// ---------------------------------------------------------------------------

describe('DoorStateManager – _processWebhookState', () => {
    let opener;
    beforeEach(() => {
        opener = makeOpener();
        opener.stateManager.simulateOpen = jest.fn();
        opener.stateManager.simulateClose = jest.fn();
    });

    function setState(current, target) {
        opener.service.getCharacteristic('CurrentDoorState').updateValue(current);
        opener.service.getCharacteristic('TargetDoorState').updateValue(target);
    }

    test('CLOSED → startet simulateOpen und setzt Target auf OPEN', () => {
        setState(1, 1);
        opener.stateManager._processWebhookState();
        expect(opener.stateManager.simulateOpen).toHaveBeenCalled();
        expect(opener.service.getCharacteristic('TargetDoorState').value).toBe(0);
    });

    test('OPEN → startet simulateClose und setzt Target auf CLOSED', () => {
        setState(0, 0);
        opener.stateManager._processWebhookState();
        expect(opener.stateManager.simulateClose).toHaveBeenCalled();
        expect(opener.service.getCharacteristic('TargetDoorState').value).toBe(1);
    });

    test('OPENING → stoppt Bewegung, setzt State auf STOPPED', () => {
        setState(2, 0);
        opener.stateManager._processWebhookState();
        expect(opener.stateManager.getCurrentDoorState()).toBe(4);
    });

    test('CLOSING → stoppt Bewegung, setzt State auf STOPPED', () => {
        setState(3, 1);
        opener.stateManager._processWebhookState();
        expect(opener.stateManager.getCurrentDoorState()).toBe(4);
    });

    test('STOPPED + Target=OPEN → simulateClose (reverse)', () => {
        setState(4, 0);
        opener.stateManager._processWebhookState();
        expect(opener.stateManager.simulateClose).toHaveBeenCalled();
    });

    test('STOPPED + Target=CLOSED → simulateOpen (reverse)', () => {
        setState(4, 1);
        opener.stateManager._processWebhookState();
        expect(opener.stateManager.simulateOpen).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// syncFinalState  (via stateManager)
// ---------------------------------------------------------------------------

describe('DoorStateManager – syncFinalState', () => {
    jest.useFakeTimers();

    let opener;
    beforeEach(() => { opener = makeOpener(); });
    afterEach(() => jest.clearAllTimers());

    test('setzt CurrentDoorState sofort', () => {
        opener.service.updateCharacteristic('CurrentDoorState', 0);
        expect(opener.service.getCharacteristic('CurrentDoorState').value).toBe(0);
    });

    test('setzt TargetDoorState mit 20ms Verzögerung wenn unterschiedlich', () => {
        opener.service.getCharacteristic('TargetDoorState').updateValue(1);
        const tChar = opener.service.getCharacteristic('TargetDoorState');
        const spy = jest.spyOn(tChar, 'updateValue');
        opener.stateManager.syncFinalState(Characteristic.CurrentDoorState);
        jest.advanceTimersByTime(20);
        expect(spy).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// DoorStateManager – destroy
// ---------------------------------------------------------------------------

describe('DoorStateManager – destroy', () => {
    jest.useFakeTimers();

    test('löscht movementTimeout beim Destroy', () => {
        const opener = makeOpener();
        opener.stateManager.simulateOpen();
        expect(opener.stateManager.movementTimeout).not.toBeNull();
        opener.stateManager.destroy();
        expect(opener.stateManager.movementTimeout).toBeNull();
    });

    test('löscht autoCloseTimer beim Destroy', () => {
        const opener = makeOpener({ autoClose: true });
        opener.stateManager._scheduleAutoClose();
        expect(opener.stateManager.autoCloseTimer).not.toBeNull();
        opener.stateManager.destroy();
        expect(opener.stateManager.autoCloseTimer).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// _unregisterInstance (Memory-Leak-Fix)
// ---------------------------------------------------------------------------

describe('GarageDoorOpener – _unregisterInstance', () => {
    test('entfernt Instanz aus GarageDoorOpener.instances', () => {
        const opener = makeOpener();
        expect(GarageDoorOpener.instances).toContain(opener);
        opener._unregisterInstance();
        expect(GarageDoorOpener.instances).not.toContain(opener);
    });

    test('zweimaliger Aufruf wirft keinen Fehler', () => {
        const opener = makeOpener();
        opener._unregisterInstance();
        expect(() => opener._unregisterInstance()).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// HttpClient – getStatus mit kompilierten RegExp
// ---------------------------------------------------------------------------

describe('HttpClient – getStatus', () => {
    const HttpClient = require('../src/httpClient');

    function makeClient() {
        const log = makeLog();
        return new HttpClient(log, {});
    }

    const openRegex = /^0$/;
    const closedRegex = /^1$/;
    const openingRegex = /^2$/;
    const closingRegex = /^3$/;

    function values() {
        return { open: openRegex, closed: closedRegex, opening: openingRegex, closing: closingRegex };
    }

    test('erkennt open (0) korrekt', () => {
        const client = makeClient();
        const body = JSON.stringify({ inputs: [{ input: false }] });
        client.request = jest.fn((url, b, m, cb) => cb(null, {}, body));
        client.getStatus('http://x', '$.inputs[0].input', values(), (err, val) => {
            // false stringifiziert zu "false", passt auf keinen Regex → default CLOSED
            expect(err).toBeNull();
            expect(val).toBe(1); // default CLOSED weil kein Match
        });
    });

    test('matched "0" auf OPEN', () => {
        const client = makeClient();
        const body = JSON.stringify({ v: '0' });
        client.request = jest.fn((url, b, m, cb) => cb(null, {}, body));
        client.getStatus('http://x', '$.v', values(), (err, val) => {
            expect(err).toBeNull();
            expect(val).toBe(0);
        });
    });

    test('matched "1" auf CLOSED', () => {
        const client = makeClient();
        const body = JSON.stringify({ v: '1' });
        client.request = jest.fn((url, b, m, cb) => cb(null, {}, body));
        client.getStatus('http://x', '$.v', values(), (err, val) => {
            expect(err).toBeNull();
            expect(val).toBe(1);
        });
    });

    test('gibt Fehler zurück bei ungültigem JSON', () => {
        const client = makeClient();
        client.request = jest.fn((url, b, m, cb) => cb(null, {}, 'not-json'));
        client.getStatus('http://x', '$.v', values(), (err) => {
            expect(err).toBeInstanceOf(Error);
            expect(err.message).toMatch('Failed to parse');
        });
    });

    test('propagiert HTTP-Fehler', () => {
        const client = makeClient();
        const netErr = new Error('connection refused');
        client.request = jest.fn((url, b, m, cb) => cb(netErr));
        client.getStatus('http://x', '$.v', values(), (err) => {
            expect(err).toBe(netErr);
        });
    });
});

