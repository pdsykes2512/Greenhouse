#include "sensors.h"
#include <Wire.h>

SensorManager Sensors;

// Humidity conversion constants
#define MOLAR_MASS_OF_WATER 18.01534
#define UNIVERSAL_GAS_CONSTANT 8.21447215

// VH400 piecewise regression (from datasheet) — converts mV to %VWC.
// The sensor is non-linear, so this curve must be applied on every reading
// AND on the calibration reference voltages so the curve shape is preserved.
static float vh400PiecewiseVWC(uint32_t mv) {
    double v = mv / 1000.0;
    float vwc;
    if      (v <= 1.10) vwc = 10.00f * v - 1.00f;
    else if (v <= 1.30) vwc = 25.00f * v - 17.50f;
    else if (v <= 1.82) vwc = 48.08f * v - 47.50f;
    else if (v <= 2.20) vwc = 26.32f * v - 7.89f;
    else                vwc = 62.50f * v - 87.50f;
    return vwc;
}

void SensorManager::init() {
    Wire.begin();
    delay(250);

    sht.begin();
    delay(100);

    if (sht.isConnected()) {
        sht_connected = true;
        Serial.println("SHT31 sensor connected");
    } else {
        sht_connected = false;
        Serial.println("SHT31 sensor NOT found");
    }
}

void SensorManager::readEnvironment(EnvironmentData& env) {
    if (!sht_connected || !sht.isConnected()) {
        Serial.println("SHT31 not available");
        env.temperature = 0;
        env.humidity = 0;
        env.absolute_humidity = 0;
        return;
    }

    bool success = sht.read();
    if (!success) {
        Serial.println("Failed to read SHT31");
        return;
    }

    env.temperature = sht.getTemperature();
    env.humidity = sht.getHumidity();
    env.absolute_humidity = calculateAbsoluteHumidity(env.temperature, env.humidity);

    // Update high/low temps
    if (env.temperature > env.temp_high) {
        env.temp_high = env.temperature;
    }
    if (env.temperature < env.temp_low) {
        env.temp_low = env.temperature;
    }

    Serial.printf("Temp: %.1f°C, Humidity: %.1f%%\n",
                  env.temperature, env.humidity);
}

float SensorManager::readSoilMoisture(uint8_t pin, uint32_t dry_v_mv, uint32_t wet_v_mv) {
    // Quick connectivity check with pulldown — disconnected pin reads near 0
    pinMode(pin, INPUT_PULLDOWN);
    delay(20);
    int quickRead = analogRead(pin);
    if (quickRead < 100) {
        last_voltage_mv = 0;
        return 0.0; // No sensor detected
    }

    // Switch to high-impedance input so the pulldown stops loading the sensor signal
    pinMode(pin, INPUT);
    delay(10);

    return readVH400(pin, dry_v_mv, wet_v_mv);
}

float SensorManager::readVH400(uint8_t analogPin, uint32_t dry_v_mv, uint32_t wet_v_mv) {
    // Throwaway reads — let the ADC's internal sample-and-hold capacitor charge
    // to this channel's voltage. Without this, the first reads after a channel
    // switch are biased toward whatever channel was last read.
    for (int i = 0; i < 10; i++) {
        analogReadMilliVolts(analogPin);
        delay(2);
    }

    uint64_t mvSum = 0;

    // analogReadMilliVolts uses the chip's eFuse-burned ADC calibration so we
    // get accurate millivolts directly.
    for (int i = 0; i < VH400_SAMPLES; i++) {
        mvSum += analogReadMilliVolts(analogPin);
        delay(VH400_SAMPLE_DELAY_MS);
    }

    uint32_t avg_mv = mvSum / VH400_SAMPLES;
    last_voltage_mv = avg_mv;

    // Always run the measured voltage through the manufacturer's piecewise
    // regression — this preserves the sensor's non-linear response curve.
    float raw_vwc = vh400PiecewiseVWC(avg_mv);

    // If both calibration points are set, anchor 0% and 100% to the user's
    // captured voltages WITHOUT discarding the curve between them. We do this
    // by computing the regression's VWC at each calibration voltage, then
    // scaling/offsetting the raw VWC into that range.
    if (wet_v_mv > 0 && wet_v_mv > dry_v_mv) {
        float dry_vwc = vh400PiecewiseVWC(dry_v_mv);
        float wet_vwc = vh400PiecewiseVWC(wet_v_mv);
        if (wet_vwc > dry_vwc) {
            float corrected = (raw_vwc - dry_vwc) * 100.0f / (wet_vwc - dry_vwc);
            return max(0.0f, min(100.0f, corrected));
        }
    }

    return max(0.0f, min(100.0f, raw_vwc));
}

float SensorManager::calculateAbsoluteHumidity(float temp, float relativeHumidity) {
    // Buck (1981) equation for saturation vapor pressure
    // Returns absolute humidity in g/m³
    return (6.1121 * pow(2.718281828, (17.67 * temp) / (temp + 243.5)) *
            relativeHumidity * MOLAR_MASS_OF_WATER) /
           ((273.15 + temp) * UNIVERSAL_GAS_CONSTANT);
}
