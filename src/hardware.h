#ifndef HARDWARE_H
#define HARDWARE_H

#include <Arduino.h>
#include "config.h"
#include "types.h"

// Hardware constants
#define NUM_PLANTS 4
#define PUMP_PIN PUMP_RELAY
#define VALVE_CLOSED LOW
#define VALVE_OPEN HIGH

// Seconds to wait after a watering burst before taking the post-burst reading.
// Long enough for ADC/sensor settling, short enough that the user sees the
// pump cycle quickly when more water is needed.
#define MEASURE_PAUSE_SEC 15

// Seconds the pump must have been off before any routine moisture read
#define PUMP_OFF_SETTLE_SEC 15

// Milliseconds to wait between reading sequential soil sensors
#define INTER_SENSOR_DELAY_MS 200

// VH400 sampling constants
#define VH400_SAMPLES 50  // Reduced from 100 to avoid watchdog timeout
#define VH400_SAMPLE_DELAY_MS 5

// Plant configuration table
const PlantConfig PLANT_CONFIGS[NUM_PLANTS] = {
    {
        .active = PLANT1_ACTIVE,
        .valve_pin = VALVE1_RELAY,
        .soil_pin = SOIL1_PIN,
        .soil_dry_threshold = PLANT1_SOIL_DRY,
        .soil_wet_threshold = PLANT1_SOIL_WET,
        .water_duration_sec = PLANT1_WATER_ON,
        .cooldown_sec = PLANT1_WATER_OFF
    },
    {
        .active = PLANT2_ACTIVE,
        .valve_pin = VALVE2_RELAY,
        .soil_pin = SOIL2_PIN,
        .soil_dry_threshold = PLANT2_SOIL_DRY,
        .soil_wet_threshold = PLANT2_SOIL_WET,
        .water_duration_sec = PLANT2_WATER_ON,
        .cooldown_sec = PLANT2_WATER_OFF
    },
    {
        .active = PLANT3_ACTIVE,
        .valve_pin = VALVE3_RELAY,
        .soil_pin = SOIL3_PIN,
        .soil_dry_threshold = PLANT3_SOIL_DRY,
        .soil_wet_threshold = PLANT3_SOIL_WET,
        .water_duration_sec = PLANT3_WATER_ON,
        .cooldown_sec = PLANT3_WATER_OFF
    },
    {
        .active = PLANT4_ACTIVE,
        .valve_pin = VALVE4_RELAY,
        .soil_pin = SOIL4_PIN,
        .soil_dry_threshold = PLANT4_SOIL_DRY,
        .soil_wet_threshold = PLANT4_SOIL_WET,
        .water_duration_sec = PLANT4_WATER_ON,
        .cooldown_sec = PLANT4_WATER_OFF
    }
};

// Initialize all hardware pins
inline void initHardware() {
    // Initialize pump relay
    pinMode(PUMP_PIN, OUTPUT);
    digitalWrite(PUMP_PIN, VALVE_CLOSED);

    // Initialize valve relays
    for (int i = 0; i < NUM_PLANTS; i++) {
        pinMode(PLANT_CONFIGS[i].valve_pin, OUTPUT);
        digitalWrite(PLANT_CONFIGS[i].valve_pin, VALVE_CLOSED);
    }

    Serial.println("Hardware initialized");
}

#endif
