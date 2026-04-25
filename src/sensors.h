#ifndef SENSORS_H
#define SENSORS_H

#include <Arduino.h>
#include <SHT31.h>
#include "types.h"
#include "hardware.h"

class SensorManager {
public:
    void init();
    void readEnvironment(EnvironmentData& env);
    // Returns calibrated VWC %. If wet_v_mv > dry_v_mv, applies linear calibration;
    // otherwise falls back to the manufacturer's piecewise regression.
    float readSoilMoisture(uint8_t pin, uint32_t dry_v_mv = 0, uint32_t wet_v_mv = 0);
    uint32_t getLastVoltageMv() const { return last_voltage_mv; }

private:
    float readVH400(uint8_t analogPin, uint32_t dry_v_mv, uint32_t wet_v_mv);
    float calculateAbsoluteHumidity(float temp, float relativeHumidity);

    SHT31 sht;
    bool sht_connected = false;
    uint32_t last_voltage_mv = 0;
};

extern SensorManager Sensors;

#endif
