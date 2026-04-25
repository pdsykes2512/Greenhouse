#include "network.h"
#include "hardware.h"
#include <ArduinoJson.h>

NetworkManager Network;

void NetworkManager::init() {
    Serial.println("\n=== Network Initialization ===");

    // Disconnect any previous connection
    WiFi.disconnect(true);
    delay(1000);

    // Start WiFi
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PSK);

    Serial.print("Connecting to WiFi");
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) {
        delay(500);
        Serial.print(".");
        attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\nWiFi Connected!");
        Serial.print("IP Address: ");
        Serial.println(WiFi.localIP());
        Serial.print("Signal: ");
        Serial.print(WiFi.RSSI());
        Serial.println(" dBm");

        // Sync time via NTP (UK timezone — GMT/BST)
        configTime(0, 0, "pool.ntp.org", "time.nist.gov");
        setenv("TZ", "GMT0BST,M3.5.0/1,M10.5.0", 1);
        tzset();
        Serial.println("NTP time sync started");
    } else {
        Serial.println("\nWiFi connection failed!");
    }

    setupOTA();
}

void NetworkManager::setupOTA() {
    ArduinoOTA.setHostname(SYSTEM_HOSTNAME);
    ArduinoOTA.setPassword(FLASH_PWD);

    ArduinoOTA.onStart([]() {
        Serial.println("\nOTA Update Started");
    });

    ArduinoOTA.onEnd([]() {
        Serial.println("\nOTA Update Complete");
    });

    ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
        Serial.printf("OTA Progress: %u%%\r", (progress * 100) / total);
    });

    ArduinoOTA.onError([](ota_error_t error) {
        Serial.printf("OTA Error[%u]: ", error);
        if (error == OTA_AUTH_ERROR) Serial.println("Auth Failed");
        else if (error == OTA_BEGIN_ERROR) Serial.println("Begin Failed");
        else if (error == OTA_CONNECT_ERROR) Serial.println("Connect Failed");
        else if (error == OTA_RECEIVE_ERROR) Serial.println("Receive Failed");
        else if (error == OTA_END_ERROR) Serial.println("End Failed");
    });

    ArduinoOTA.begin();
    Serial.println("OTA Ready");
}

void NetworkManager::update() {
    ArduinoOTA.handle();

    // Auto-reconnect WiFi if disconnected
    if (WiFi.status() != WL_CONNECTED) {
        if (millis() - lastReconnectAttempt > RECONNECT_INTERVAL) {
            Serial.println("WiFi disconnected, reconnecting...");
            WiFi.disconnect();
            WiFi.begin(WIFI_SSID, WIFI_PSK);
            lastReconnectAttempt = millis();
        }
    }
}

bool NetworkManager::isConnected() {
    return WiFi.status() == WL_CONNECTED;
}

bool NetworkManager::postSensorData(EnvironmentData& env, const PlantState plants[]) {
    if (!isConnected()) {
        Serial.println("Cannot post data - WiFi not connected");
        return false;
    }

    HTTPClient http;
    http.begin(String(SERVER_URL) + "/api/data");
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(HTTP_TIMEOUT);

    // Build JSON payload
    JsonDocument doc;

    doc["temperature"] = env.temperature;
    doc["humidity"] = env.humidity;
    doc["absolute_humidity"] = env.absolute_humidity;
    doc["temp_high"] = env.temp_high;
    doc["temp_low"] = env.temp_low;

    JsonArray plantsArray = doc["plants"].to<JsonArray>();
    for (int i = 0; i < NUM_PLANTS; i++) {
        JsonObject plant = plantsArray.add<JsonObject>();
        plant["plant"] = i + 1;
        plant["soil_moisture"] = plants[i].soil_moisture;
        plant["soil_voltage_mv"] = plants[i].soil_voltage_mv;
        plant["soil_temp"] = plants[i].soil_temp;
        plant["valve_state"] = plants[i].valve_open;
        plant["progress"] = plants[i].progress_percent;
    }

    String payload;
    serializeJson(doc, payload);

    // Send request
    int httpCode = http.POST(payload);

    if (httpCode == 200) {
        // Parse server response — it includes today's MIN/MAX so the OLED
        // can show the same Hi/Lo as the website (and survives reboot).
        String body = http.getString();
        JsonDocument resp;
        if (!deserializeJson(resp, body)) {
            if (resp["temp_high"].is<float>()) env.temp_high = resp["temp_high"];
            if (resp["temp_low"].is<float>())  env.temp_low  = resp["temp_low"];
        }
        Serial.println("Data posted successfully");
        http.end();
        return true;
    } else {
        Serial.printf("POST failed, code: %d\n", httpCode);
        http.end();
        return false;
    }
}

bool NetworkManager::getCommands(SystemCommands& commands) {
    if (!isConnected()) {
        return false;
    }

    HTTPClient http;
    http.begin(String(SERVER_URL) + "/api/commands");
    http.setTimeout(HTTP_TIMEOUT);

    int httpCode = http.GET();

    if (httpCode == 200) {
        String response = http.getString();

        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, response);

        if (error) {
            Serial.printf("JSON parse error: %s\n", error.c_str());
            http.end();
            return false;
        }

        // Parse commands
        commands.auto_mode = doc["auto_mode"] | true;
        commands.pump_override = doc["pump_override"] | false;

        JsonObject valves = doc["valves"];
        commands.valve_overrides[0] = valves["1"] | false;
        commands.valve_overrides[1] = valves["2"] | false;
        commands.valve_overrides[2] = valves["3"] | false;
        commands.valve_overrides[3] = valves["4"] | false;

        JsonObject plants_active = doc["plants_active"];
        commands.plants_active[0] = plants_active["1"] | false;
        commands.plants_active[1] = plants_active["2"] | false;
        commands.plants_active[2] = plants_active["3"] | false;
        commands.plants_active[3] = plants_active["4"] | false;

        commands.last_updated = millis();

        // Parse per-plant settings (fallback to existing values if key absent)
        JsonObject plant_settings = doc["plant_settings"];
        for (int i = 0; i < NUM_PLANTS; i++) {
            String key = String(i + 1);
            if (plant_settings[key].is<JsonObject>()) {
                JsonObject ps = plant_settings[key];
                commands.plant_settings[i].soil_dry_threshold = ps["soil_dry_threshold"] | commands.plant_settings[i].soil_dry_threshold;
                commands.plant_settings[i].soil_wet_threshold = ps["soil_wet_threshold"] | commands.plant_settings[i].soil_wet_threshold;
                commands.plant_settings[i].water_duration_sec = ps["water_duration_sec"] | commands.plant_settings[i].water_duration_sec;
                commands.plant_settings[i].cooldown_sec       = ps["cooldown_sec"]       | commands.plant_settings[i].cooldown_sec;
                commands.plant_settings[i].dry_voltage_mv     = ps["dry_voltage_mv"]     | commands.plant_settings[i].dry_voltage_mv;
                commands.plant_settings[i].wet_voltage_mv     = ps["wet_voltage_mv"]     | commands.plant_settings[i].wet_voltage_mv;
            }
        }

        http.end();
        return true;
    } else {
        http.end();
        return false;
    }
}
