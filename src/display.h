#ifndef DISPLAY_H
#define DISPLAY_H

#include <Arduino.h>
#include <Adafruit_SH110X.h>
#include "types.h"
#include "hardware.h"
#include "config.h"

class DisplayManager {
public:
    DisplayManager() : display(nullptr) {}
    ~DisplayManager() { if (display) delete display; }
    void init();
    void update(const EnvironmentData& env, const PlantState plants[]);
    void clear();

private:
    Adafruit_SH1106G* display;
    bool connected = false;
};

extern DisplayManager Display;

#endif
