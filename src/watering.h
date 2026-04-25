#ifndef WATERING_H
#define WATERING_H

#include <Arduino.h>
#include "types.h"
#include "hardware.h"
#include "sensors.h"

class WateringController {
public:
    void init();
    void update();
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
};

extern WateringController Watering;

#endif
