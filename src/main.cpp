#include <Arduino.h>
#include "config.h"
#include "types.h"
#include "hardware.h"
#include "network.h"
#include "sensors.h"
#include "watering.h"
#include "display.h"

// Global state
EnvironmentData environment = {
    .temperature = 0,
    .humidity = 0,
    .absolute_humidity = 0,
    .temp_high = -100,
    .temp_low = 100
};

SystemCommands commands;

// Timing
unsigned long lastCommandFetch = 0;
unsigned long lastDataPost = 0;
unsigned long lastSensorRead = 0;
unsigned long lastDisplayUpdate = 0;
unsigned long lastHeartbeat = 0;

void setup() {
    Serial.begin(115200);
    delay(100);

    Serial.println("\n\n========================================");
    Serial.println("   GREENHOUSE CONTROL SYSTEM v2.0");
    Serial.println("========================================\n");

    // Initialize hardware
    initHardware();

    // Initialize heartbeat LED
    pinMode(LED_BUILTIN, OUTPUT);

    // Initialize network (WiFi + OTA)
    Network.init();

    // Initialize sensors
    Sensors.init();

    // Initialize display
    Display.init();

    // Initialize watering controller
    Watering.init();

    // Pre-seed plant_settings in the shared commands struct so that the first
    // getCommands() poll has valid fallback values in its | expressions
    for (int i = 0; i < NUM_PLANTS; i++) {
        commands.plant_settings[i].soil_dry_threshold = PLANT_CONFIGS[i].soil_dry_threshold;
        commands.plant_settings[i].soil_wet_threshold = PLANT_CONFIGS[i].soil_wet_threshold;
        commands.plant_settings[i].water_duration_sec = PLANT_CONFIGS[i].water_duration_sec;
        commands.plant_settings[i].cooldown_sec       = PLANT_CONFIGS[i].cooldown_sec;
    }

    Serial.println("\n========================================");
    Serial.println("System ready!");
    Serial.println("========================================\n");

    // Initial sensor read
    Sensors.readEnvironment(environment);
}

void loop() {
    // Always handle network tasks (OTA + WiFi reconnect)
    Network.update();

    // Fetch commands from server every 10 seconds
    if (millis() - lastCommandFetch >= COMMAND_POLL_INTERVAL) {
        if (Network.getCommands(commands)) {
            Watering.applyCommands(commands);
        }
        lastCommandFetch = millis();
    }

    // Read sensors every minute
    if (millis() - lastSensorRead >= 60000) {
        Sensors.readEnvironment(environment);
        lastSensorRead = millis();
    }

    // Update watering logic every second. update() returns true if a fresh
    // moisture read happened this tick — push it to the server immediately so
    // the dashboard doesn't have to wait up to a minute for the next post.
    static unsigned long lastWateringUpdate = 0;
    bool freshRead = false;
    if (millis() - lastWateringUpdate >= 1000) {
        freshRead = Watering.update();
        lastWateringUpdate = millis();
    }

    // Update display every 2 seconds
    if (millis() - lastDisplayUpdate >= 2000) {
        Display.update(environment, Watering.getPlantStates());
        lastDisplayUpdate = millis();
    }

    // Post sensor data to server every minute, OR immediately after a fresh read
    if (freshRead || millis() - lastDataPost >= DATA_POST_INTERVAL) {
        Network.postSensorData(environment, Watering.getPlantStates());
        lastDataPost = millis();
    }

    // When a manual cycle completes (wet enough OR ignored because already wet),
    // tell the server to release the override so the user can re-trigger it later.
    uint8_t completed = Watering.fetchAndClearCompletedManualCycles();
    if (completed) {
        for (int i = 0; i < NUM_PLANTS; i++) {
            if (completed & (1 << i)) {
                Network.clearValveOverride(i + 1);
            }
        }
    }

    // Heartbeat LED (blink every second)
    if (millis() - lastHeartbeat >= 1000) {
        digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
        lastHeartbeat = millis();
    }

    // Small delay to prevent watchdog issues
    delay(10);
}
