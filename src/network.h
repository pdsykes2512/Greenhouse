#ifndef NETWORK_H
#define NETWORK_H

#include <Arduino.h>
#include <WiFi.h>
#include <ArduinoOTA.h>
#include <HTTPClient.h>
#include "config.h"
#include "types.h"

class NetworkManager {
public:
    void init();
    void update();
    bool postSensorData(EnvironmentData& env, const PlantState plants[]);
    bool getCommands(SystemCommands& commands);
    bool clearValveOverride(uint8_t plantNumber);  // 1-based plant number
    bool isConnected();

private:
    void setupOTA();
    void handleWiFiReconnect();

    unsigned long lastReconnectAttempt = 0;
    const unsigned long RECONNECT_INTERVAL = 5000;
};

extern NetworkManager Network;

#endif
