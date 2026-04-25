#include "watering.h"

WateringController Watering;

void WateringController::init() {
    // Initialize all plant states
    for (int i = 0; i < NUM_PLANTS; i++) {
        plants[i].soil_moisture = 0;
        plants[i].soil_voltage_mv = 0;
        plants[i].soil_temp = 0;
        plants[i].valve_open = false;
        plants[i].valve_timer = millis();
        plants[i].progress_percent = 0;
        plants[i].in_measure_pause = false;
        plants[i].measure_pause_start = 0;
    }

    // Default commands (auto mode enabled, no overrides)
    currentCommands.auto_mode = true;
    currentCommands.pump_override = false;
    for (int i = 0; i < NUM_PLANTS; i++) {
        currentCommands.valve_overrides[i] = false;
        currentCommands.plants_active[i] = false;  // Will be updated from server
        // Seed plant settings from hardcoded config as fallback until server responds
        currentCommands.plant_settings[i].soil_dry_threshold = PLANT_CONFIGS[i].soil_dry_threshold;
        currentCommands.plant_settings[i].soil_wet_threshold = PLANT_CONFIGS[i].soil_wet_threshold;
        currentCommands.plant_settings[i].water_duration_sec = PLANT_CONFIGS[i].water_duration_sec;
        currentCommands.plant_settings[i].cooldown_sec       = PLANT_CONFIGS[i].cooldown_sec;
        currentCommands.plant_settings[i].dry_voltage_mv     = 0;  // 0 = uncalibrated
        currentCommands.plant_settings[i].wet_voltage_mv     = 0;
    }

    Serial.println("Watering controller initialized");
}

void WateringController::update() {
    static unsigned long lastMoistureRead = 0;
    static unsigned long pumpOffTime     = 0;
    static bool          wasPumpActive   = false;

    bool anyOpen = false;
    for (int i = 0; i < NUM_PLANTS; i++) {
        if (plants[i].valve_open) { anyOpen = true; break; }
    }

    // Track the moment the pump (valve or manual override) stops
    bool pumpActive = anyOpen || currentCommands.pump_override;
    if (wasPumpActive && !pumpActive) {
        pumpOffTime = millis();
        Serial.println("Pump stopped — moisture reads held for settle period");
    }
    wasPumpActive = pumpActive;

    // Only read moisture when:
    //   1. No valve/pump is active
    //   2. Pump has been off for at least PUMP_OFF_SETTLE_SEC (electrical settling)
    //   3. At least 60 s since the last read
    bool settled = (millis() - pumpOffTime) >= (PUMP_OFF_SETTLE_SEC * 1000UL);

    if (!pumpActive && settled && millis() - lastMoistureRead >= 60000) {
        // Read every sensor, regardless of plant_active state. Keeping the read
        // sequence constant means a sensor's value can't shift just because
        // another plant was toggled on/off in the UI.
        for (int i = 0; i < NUM_PLANTS; i++) {
            const PlantSettings& s = currentCommands.plant_settings[i];
            plants[i].soil_moisture = Sensors.readSoilMoisture(
                PLANT_CONFIGS[i].soil_pin, s.dry_voltage_mv, s.wet_voltage_mv);
            plants[i].soil_voltage_mv = Sensors.getLastVoltageMv();
            Serial.printf("Plant %d moisture: %.1f%% (raw %u mV)\n",
                          i + 1, plants[i].soil_moisture, plants[i].soil_voltage_mv);
            if (i < NUM_PLANTS - 1) delay(INTER_SENSOR_DELAY_MS);
        }
        lastMoistureRead = millis();
    }

    // Update automatic watering logic
    if (currentCommands.auto_mode) {
        updateAutoWatering();
    }

    // Apply manual overrides
    updateManualOverrides();

    // Update pump based on valve states
    updatePump();
}

void WateringController::applyCommands(const SystemCommands& commands) {
    currentCommands = commands;

    // Fallback to hardcoded defaults for any invalid/zero settings from server
    for (int i = 0; i < NUM_PLANTS; i++) {
        PlantSettings& s = currentCommands.plant_settings[i];
        if (s.soil_dry_threshold <= 0 || s.soil_wet_threshold <= 0 ||
            s.soil_dry_threshold >= s.soil_wet_threshold) {
            s.soil_dry_threshold = PLANT_CONFIGS[i].soil_dry_threshold;
            s.soil_wet_threshold = PLANT_CONFIGS[i].soil_wet_threshold;
        }
        if (s.water_duration_sec == 0) {
            s.water_duration_sec = PLANT_CONFIGS[i].water_duration_sec;
        }
    }

    Serial.printf("Commands applied - Auto: %d, Pump: %d\n",
                  commands.auto_mode, commands.pump_override);
}

void WateringController::updateAutoWatering() {
    bool valveAlreadyOpen = false;
    for (int i = 0; i < NUM_PLANTS; i++) {
        if (plants[i].valve_open) { valveAlreadyOpen = true; break; }
    }

    for (int i = 0; i < NUM_PLANTS; i++) {
        if (!currentCommands.plants_active[i]) continue;

        const PlantSettings& config = currentCommands.plant_settings[i];
        PlantState& state = plants[i];

        uint32_t elapsedTime = (millis() - state.valve_timer) / 1000;

        if (state.valve_open) {
            // Close when the watering burst time is up; pump interference means we
            // can't trust moisture readings while running, so time is the only criterion
            if (elapsedTime >= config.water_duration_sec) {
                setValve(i, false);
                state.valve_timer = millis();
                state.in_measure_pause = true;
                state.measure_pause_start = millis();
                Serial.printf("Plant %d: Burst done, pausing to measure\n", i + 1);
            }

            state.progress_percent = 100 - ((elapsedTime * 100) / config.water_duration_sec);
            state.progress_percent = constrain(state.progress_percent, 0, 100);

        } else if (state.in_measure_pause) {
            // Pump is off — wait for noise to settle, then read and decide
            state.progress_percent = 0;
            uint32_t pauseElapsed = (millis() - state.measure_pause_start) / 1000;
            if (pauseElapsed >= MEASURE_PAUSE_SEC) {
                state.soil_moisture = Sensors.readSoilMoisture(
                    PLANT_CONFIGS[i].soil_pin, config.dry_voltage_mv, config.wet_voltage_mv);
                state.soil_voltage_mv = Sensors.getLastVoltageMv();
                state.in_measure_pause = false;
                Serial.printf("Plant %d: Post-burst moisture: %.1f%%\n", i + 1, state.soil_moisture);

                if (state.soil_moisture < config.soil_wet_threshold && !valveAlreadyOpen) {
                    // Still dry — run another burst
                    setValve(i, true);
                    state.valve_timer = millis();
                    valveAlreadyOpen = true;
                    Serial.printf("Plant %d: Still dry, running another burst\n", i + 1);
                } else {
                    // Wet enough — start normal cooldown from now
                    state.valve_timer = millis();
                }
            }

        } else {
            // Normal cooldown — open when dry and cooldown has elapsed
            uint32_t cooldownProgress = (elapsedTime * 100) / config.cooldown_sec;
            state.progress_percent = constrain(cooldownProgress, 0, 100);

            if (state.soil_moisture < config.soil_dry_threshold &&
                elapsedTime >= config.cooldown_sec &&
                !valveAlreadyOpen) {
                setValve(i, true);
                state.valve_timer = millis();
                valveAlreadyOpen = true;
                Serial.printf("Plant %d: Needs water (%.1f%% < %.1f%%)\n",
                              i + 1, state.soil_moisture, config.soil_dry_threshold);
            }
        }
    }
}

void WateringController::updateManualOverrides() {
    // Process closures first so a close+open in the same command set works correctly
    for (int i = 0; i < NUM_PLANTS; i++) {
        bool shouldBeOpen = currentCommands.valve_overrides[i] &&
                            (currentCommands.plants_active[i] || currentCommands.valve_overrides[i]);
        if (!shouldBeOpen && plants[i].valve_open) {
            Serial.printf("Manual override: Valve %d -> CLOSED\n", i + 1);
            setValve(i, false);
        }
    }

    // Then process opens, honouring the one-at-a-time rule
    for (int i = 0; i < NUM_PLANTS; i++) {
        if (!currentCommands.valve_overrides[i]) continue;

        if (plants[i].valve_open) continue; // already open (this plant)

        // Check no other valve is open
        bool otherOpen = false;
        for (int j = 0; j < NUM_PLANTS; j++) {
            if (j != i && plants[j].valve_open) { otherOpen = true; break; }
        }
        if (otherOpen) continue;

        Serial.printf("Manual override: Valve %d -> OPEN\n", i + 1);
        setValve(i, true);
    }
}

void WateringController::updatePump() {
    // Count open valves
    anyValveOpen = false;
    for (int i = 0; i < NUM_PLANTS; i++) {
        if (plants[i].valve_open) {
            anyValveOpen = true;
            break;
        }
    }

    // Pump should be ON if:
    // 1. Any valve is open, OR
    // 2. Manual pump override is enabled
    bool pumpShouldBeOn = anyValveOpen || currentCommands.pump_override;

    digitalWrite(PUMP_PIN, pumpShouldBeOn ? VALVE_OPEN : VALVE_CLOSED);

    static bool lastPumpState = false;
    if (pumpShouldBeOn != lastPumpState) {
        Serial.printf("Pump: %s (valves: %d, override: %d)\n",
                      pumpShouldBeOn ? "ON" : "OFF",
                      anyValveOpen, currentCommands.pump_override);
        lastPumpState = pumpShouldBeOn;
    }
}

void WateringController::setValve(uint8_t plantIndex, bool shouldOpen) {
    if (plantIndex >= NUM_PLANTS) return;

    // Turn pump off before closing a valve to prevent over-pressurisation
    if (!shouldOpen && plants[plantIndex].valve_open) {
        digitalWrite(PUMP_PIN, VALVE_CLOSED);
        delay(300);
    }

    plants[plantIndex].valve_open = shouldOpen;
    digitalWrite(PLANT_CONFIGS[plantIndex].valve_pin,
                 shouldOpen ? VALVE_OPEN : VALVE_CLOSED);

    Serial.printf("Valve %d: %s\n", plantIndex + 1, shouldOpen ? "OPEN" : "CLOSED");
}
