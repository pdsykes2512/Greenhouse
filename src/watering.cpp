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

bool WateringController::update() {
    static unsigned long lastMoistureRead = 0;
    static unsigned long pumpOffTime     = 0;
    static bool          wasPumpActive   = false;
    bool freshRead = false;

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
    //   4. No plant is mid-cycle in measure-pause — its post-burst read needs
    //      the full MEASURE_PAUSE_SEC settle window and we don't want to
    //      pre-empt it with a routine read at PUMP_OFF_SETTLE_SEC seconds in.
    bool settled = (millis() - pumpOffTime) >= (PUMP_OFF_SETTLE_SEC * 1000UL);
    bool anyMidCycle = false;
    for (int i = 0; i < NUM_PLANTS; i++) {
        if (plants[i].in_measure_pause) { anyMidCycle = true; break; }
    }

    if (!pumpActive && !anyMidCycle && settled && millis() - lastMoistureRead >= 60000) {
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
        freshRead = true;
    }

    // Unified watering state machine — handles both auto and manual cycles.
    // updateAutoWatering's per-plant logic checks plants_active vs. valve_overrides
    // and respects auto_mode for auto-only triggers.
    updateAutoWatering();

    // Honour user clicking CLOSE mid-cycle
    updateManualOverrides();

    // Update pump based on valve states
    updatePump();

    bool wasFresh = freshRead || freshReadThisTick || valveChangedThisTick;
    freshReadThisTick = false;
    valveChangedThisTick = false;
    return wasFresh;
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
        bool active = currentCommands.plants_active[i];
        bool manual = currentCommands.valve_overrides[i];

        // Process plants that are either auto-active OR manually triggered.
        // Manual triggers run the same burst-measure-pause cycle as auto so the
        // plant cannot be over-watered (cycle stops automatically when the wet
        // threshold is reached).
        if (!active && !manual) continue;

        const PlantSettings& config = currentCommands.plant_settings[i];
        PlantState& state = plants[i];

        uint32_t elapsedTime = (millis() - state.valve_timer) / 1000;

        if (state.valve_open) {
            // Burst in progress — close after water_duration_sec and enter
            // the measure-pause to read moisture before deciding what's next.
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
            state.progress_percent = 0;
            uint32_t pauseElapsed = (millis() - state.measure_pause_start) / 1000;
            if (pauseElapsed >= MEASURE_PAUSE_SEC) {
                state.soil_moisture = Sensors.readSoilMoisture(
                    PLANT_CONFIGS[i].soil_pin, config.dry_voltage_mv, config.wet_voltage_mv);
                state.soil_voltage_mv = Sensors.getLastVoltageMv();
                state.in_measure_pause = false;
                freshReadThisTick = true;
                Serial.printf("Plant %d: Post-burst moisture: %.1f%%\n", i + 1, state.soil_moisture);

                if (state.soil_moisture < config.soil_wet_threshold && !valveAlreadyOpen) {
                    // Still dry — run another burst
                    setValve(i, true);
                    state.valve_timer = millis();
                    valveAlreadyOpen = true;
                    Serial.printf("Plant %d: Still dry, running another burst\n", i + 1);
                } else {
                    // Wet enough — cycle complete. If it was a manual cycle,
                    // tell main.cpp so it can release the override on the server.
                    state.valve_timer = millis();
                    if (manuallyTriggered[i]) {
                        manuallyTriggered[i] = false;
                        completedManualCycles |= (1 << i);
                        Serial.printf("Plant %d: Manual cycle complete, wet enough\n", i + 1);
                    }
                }
            }

        } else {
            // Idle — decide whether to start a new cycle
            uint32_t cooldownProgress = (elapsedTime * 100) / config.cooldown_sec;
            state.progress_percent = constrain(cooldownProgress, 0, 100);

            bool needsWater = false;
            if (manual) {
                // Manual: water if not at wet threshold yet (cooldown bypassed)
                needsWater = state.soil_moisture < config.soil_wet_threshold;
            } else if (active) {
                // Per-plant auto: water if dry AND cooldown has elapsed.
                // (plants_active is now the per-plant auto-watering toggle —
                // there's no longer a global auto_mode kill switch.)
                needsWater = state.soil_moisture < config.soil_dry_threshold &&
                             elapsedTime >= config.cooldown_sec;
            }

            if (needsWater && !valveAlreadyOpen) {
                setValve(i, true);
                state.valve_timer = millis();
                valveAlreadyOpen = true;
                manuallyTriggered[i] = manual;
                Serial.printf("Plant %d: Watering started (%s, soil %.1f%%)\n",
                              i + 1, manual ? "manual" : "auto", state.soil_moisture);
            } else if (manual && !needsWater) {
                // Manual was triggered but plant is already wet enough.
                // Release the override so the user can re-trigger later.
                completedManualCycles |= (1 << i);
                Serial.printf("Plant %d: Manual ignored — already wet (%.1f%%)\n",
                              i + 1, state.soil_moisture);
            }
        }
    }
}

void WateringController::updateManualOverrides() {
    // Sole responsibility now: if the user releases the override mid-cycle
    // (clicks CLOSE), abort whatever's in flight. Auto-only opens are not
    // touched here.
    for (int i = 0; i < NUM_PLANTS; i++) {
        if (currentCommands.valve_overrides[i]) continue;
        if (!manuallyTriggered[i]) continue;

        if (plants[i].valve_open) {
            Serial.printf("Manual override released — closing valve %d\n", i + 1);
            setValve(i, false);
        }
        plants[i].in_measure_pause = false;
        manuallyTriggered[i] = false;
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

    bool wasOpen = plants[plantIndex].valve_open;
    plants[plantIndex].valve_open = shouldOpen;
    digitalWrite(PLANT_CONFIGS[plantIndex].valve_pin,
                 shouldOpen ? VALVE_OPEN : VALVE_CLOSED);

    if (wasOpen != shouldOpen) {
        // Force an immediate data POST so the server captures this transition
        // before the valve closes again — short bursts (15 s) would otherwise
        // never appear in the readings table and never show on the chart.
        valveChangedThisTick = true;
    }

    Serial.printf("Valve %d: %s\n", plantIndex + 1, shouldOpen ? "OPEN" : "CLOSED");
}
