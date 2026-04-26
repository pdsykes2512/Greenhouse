#ifndef WATERING_H
#define WATERING_H

#include <Arduino.h>
#include "types.h"
#include "hardware.h"
#include "sensors.h"

class WateringController {
public:
    void init();
    // Returns true if a fresh moisture read was taken on this tick — the
    // caller can use this to trigger an immediate data POST so the dashboard
    // doesn't wait up to a minute for the next scheduled push.
    bool update();
    void applyCommands(const SystemCommands& commands);
    PlantState* getPlantStates() { return plants; }

private:
    void updateAutoWatering();
    void updateManualOverrides();
    void updatePump();
    void setValve(uint8_t plantIndex, bool shouldOpen);

    PlantState plants[NUM_PLANTS];
    SystemCommands currentCommands;
    bool anyValveOpen = false;
    bool freshReadThisTick = false;          // Set by any function that takes a sensor read
    bool valveChangedThisTick = false;       // Set by setValve so main.cpp posts immediately
    bool manuallyTriggered[NUM_PLANTS] = {}; // Track which active cycles started via manual override
    uint8_t completedManualCycles = 0;       // Bitmask: bit N set when manual cycle for plant N+1 just finished
public:
    // main.cpp checks this each tick — for any bit set, it tells the server to
    // release the manual valve override (so the user can trigger another cycle).
    uint8_t fetchAndClearCompletedManualCycles() {
        uint8_t m = completedManualCycles;
        completedManualCycles = 0;
        return m;
    }
};

extern WateringController Watering;

#endif
