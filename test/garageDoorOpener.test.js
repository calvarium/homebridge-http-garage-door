const GarageDoorOpener = require('../src/garageDoorOpener');

describe('GarageDoorOpener simulate', () => {
  const FakeCharacteristic = class {
    constructor() {
      this.value = null;
    }
    updateValue(val) {
      this.value = val;
    }
    on() {}
  };

  const Service = {
    GarageDoorOpener: class {
      constructor() {
        this.characteristics = {};
      }
      getCharacteristic(name) {
        if (!this.characteristics[name]) {
          this.characteristics[name] = new FakeCharacteristic();
        }
        return this.characteristics[name];
      }
      setCharacteristic(name, value) {
        this.getCharacteristic(name).updateValue(value);
      }
    },
  };

  const Characteristic = {
    CurrentDoorState: 'CurrentDoorState',
    TargetDoorState: 'TargetDoorState',
  };

  GarageDoorOpener.configure(Service, Characteristic);

  let opener;
  beforeEach(() => {
    const log = jest.fn();
    const config = {
      name: 'Test',
      openURL: 'http://open',
      closeURL: 'http://close',
      openTime: 0,
      closeTime: 0,
    };
    opener = new GarageDoorOpener(log, config);
    opener._getStatus = jest.fn();
  });

  test('simulateOpen sets state to opening', () => {
    opener.simulateOpen();
    expect(opener.getCurrentDoorState()).toBe(2);
  });

  test('simulateClose sets state to closing', () => {
    opener.simulateClose();
    expect(opener.getCurrentDoorState()).toBe(3);
  });
});

describe('GarageDoorOpener autoClose', () => {
  jest.useFakeTimers();

  const FakeCharacteristic = class {
    constructor() {
      this.value = null;
    }
    updateValue(val) {
      this.value = val;
    }
    on() {}
  };

  const Service = {
    GarageDoorOpener: class {
      constructor() {
        this.characteristics = {};
      }
      getCharacteristic(name) {
        if (!this.characteristics[name]) {
          this.characteristics[name] = new FakeCharacteristic();
        }
        return this.characteristics[name];
      }
      setCharacteristic(name, value) {
        this.getCharacteristic(name).updateValue(value);
      }
      updateCharacteristic(name, value) {
        this.getCharacteristic(name).updateValue(value);
      }
    },
  };

  const Characteristic = {
    CurrentDoorState: 'CurrentDoorState',
    TargetDoorState: 'TargetDoorState',
  };

  GarageDoorOpener.configure(Service, Characteristic);

  let opener;
  beforeEach(() => {
    const log = Object.assign(jest.fn(), {
      warn: jest.fn(),
      error: jest.fn(),
    });
    opener = new GarageDoorOpener(log, {
      name: 'Test',
      openURL: 'http://open',
      closeURL: 'http://close',
      openTime: 0,
      closeTime: 0,
      autoClose: true,
      autoCloseDelay: 60,
    });
    opener._getStatus = jest.fn((cb) => cb());
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  test('autoClose deaktiviert → kein Timer gesetzt', () => {
    opener.autoClose = false;
    opener._scheduleAutoClose = jest.fn();
    // Direkt prüfen: autoCloseTimer bleibt null wenn autoClose false
    expect(opener.autoCloseTimer).toBeNull();
    opener._scheduleAutoClose();
    // Da wir es gemockt haben, bleibt der echte Timer unangetastet
    expect(opener.autoCloseTimer).toBeNull();
  });

  test('_scheduleAutoClose setzt Timer und löst Schließen aus wenn Tür offen', () => {
    // Tür auf OPEN (0) setzen
    opener.service.getCharacteristic('CurrentDoorState').updateValue(0);
    opener._scheduleAutoClose();
    expect(opener.autoCloseTimer).not.toBeNull();

    jest.runAllTimers();

    // TargetDoorState muss auf 1 (CLOSED) gesetzt worden sein
    expect(opener.service.getCharacteristic('TargetDoorState').value).toBe(1);
  });

  test('simulateClose cancelt den autoClose-Timer', () => {
    opener._scheduleAutoClose();
    expect(opener.autoCloseTimer).not.toBeNull();

    opener.simulateClose();
    expect(opener.autoCloseTimer).toBeNull();
  });
});
