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
            if (typeof instance.startWebhookServer === 'function') {
                instance.startWebhookServer();
                instance._getStatus(function() {});
            }
            if (typeof instance.startDeconzListener === 'function') {
                instance.startDeconzListener();
            }
        });
    });

    homebridge.on('shutdown', () => {
        GarageDoorOpener.instances.forEach(instance => {
            if (typeof instance.stopWebhookServer === 'function') {
                instance.stopWebhookServer();
            }
            if (typeof instance.stopDeconzListener === 'function') {
                instance.stopDeconzListener();
            }
        });
    });
};
