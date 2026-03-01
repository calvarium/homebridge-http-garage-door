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
            instance.startWebhookServer();
            instance._getStatus(function() {});
            instance.startDeconzListener();
        });
    });

    homebridge.on('shutdown', () => {
        // Kopie erstellen, da _unregisterInstance das Array während der Iteration verändert
        [...GarageDoorOpener.instances].forEach(instance => {
            instance.stopPolling();
            instance.stopWebhookServer();
            instance.stopDeconzListener();
            instance._unregisterInstance();
        });
    });
};
