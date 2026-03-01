let Service, Characteristic;
const GarageDoorOpener = require('./src/garageDoorOpener');

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    GarageDoorOpener.configure(Service, Characteristic);

    homebridge.registerAccessory(
        'homebridge-garage-door-shelly1',
        'GarageDoorOpener',
        GarageDoorOpener,
    );

    homebridge.on('didFinishLaunching', () => {
        GarageDoorOpener.instances.forEach(instance => {
            instance.start();
        });
    });

    homebridge.on('shutdown', () => {
        GarageDoorOpener.instances.forEach(instance => {
            instance.stop();
            instance.stateManager.destroy();
            instance._unregisterInstance();
        });
    });
};
