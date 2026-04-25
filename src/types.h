#ifndef TYPES_H
#define TYPES_H

#include <Arduino.h>

// Configurable per-plant watering settings (served from server, override hardcoded defaults)
struct PlantSettings {
    float    soil_dry_threshold;
    float    soil_wet_threshold;
    uint32_t water_duration_sec;
    uint32_t cooldown_sec;
    uint32_t dry_voltage_mv;     // 0 = not calibrated; otherwise raw mV at 0% (in air)
    uint32_t wet_voltage_mv;     // 0 = not calibrated; otherwise raw mV at 100% (submerged)
};

// Plant configuration (from config.h)
struct PlantConfig {
    bool active;
    uint8_t valve_pin;
    uint8_t soil_pin;
    float soil_dry_threshold;    // Start watering below this %
    float soil_wet_threshold;    // Stop watering above this %
    uint32_t water_duration_sec; // Max watering time
    uint32_t cooldown_sec;       // Time between waterings
};

// Plant runtime state
struct PlantState {
    float soil_moisture;
    uint32_t soil_voltage_mv;    // Latest raw VH400 voltage in mV (sent to server for calibration)
    float soil_temp;
    bool valve_open;
    uint32_t valve_timer;        // Timestamp when valve state changed
    uint8_t progress_percent;    // Progress to next watering (0-100)
    bool in_measure_pause;       // Pump off, waiting to read moisture before continuing
    uint32_t measure_pause_start;
};

// System commands from server
struct SystemCommands {
    bool auto_mode;
    bool pump_override;
    bool valve_overrides[4];
    bool plants_active[4];
    uint32_t last_updated;
    PlantSettings plant_settings[4];
};

// Environmental data
struct EnvironmentData {
    float temperature;
    float humidity;
    float absolute_humidity;
    float temp_high;
    float temp_low;
};

#endif
