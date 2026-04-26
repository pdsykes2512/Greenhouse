#include <Arduino.h>
#include <WiFi.h>
#include <ArduinoOTA.h>
#include "config.h"

// Simple status LED blink to show the device is running
void blinkLED() {
  static unsigned long lastBlink = 0;
  static bool ledState = false;

  if (millis() - lastBlink > 1000) {
    ledState = !ledState;
    digitalWrite(LED_BUILTIN, ledState);
    lastBlink = millis();
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);

  Serial.println("\n\n=================================");
  Serial.println("Greenhouse OTA Boot Loader");
  Serial.println("=================================\n");

  // SAFETY: Turn off all relays immediately
  Serial.println("Initializing relay pins (all OFF)...");
  pinMode(D2, OUTPUT);
  digitalWrite(D2, LOW);  // Valve 4 off
  pinMode(D3, OUTPUT);
  digitalWrite(D3, LOW);  // Valve 3 off
  pinMode(D4, OUTPUT);
  digitalWrite(D4, LOW);  // Valve 2 off
  pinMode(D5, OUTPUT);
  digitalWrite(D5, LOW);  // Valve 1 off
  pinMode(D6, OUTPUT);
  digitalWrite(D6, LOW);  // Pump off
  Serial.println("All relays safely disabled.\n");

  // Connect to WiFi
  Serial.print("Connecting to WiFi: ");
  Serial.println(SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(SSID, PSK);

  // Wait for connection with timeout
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
    Serial.print("Signal Strength: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
  } else {
    Serial.println("\nWiFi Connection Failed!");
    Serial.println("Device will restart in 10 seconds...");
    delay(10000);
    ESP.restart();
  }

  // Setup OTA
  ArduinoOTA.setHostname(SYSTEM_HOSTNAME);
  ArduinoOTA.setPassword(FLASH_PWD);

  ArduinoOTA.onStart([]() {
    String type = (ArduinoOTA.getCommand() == U_FLASH) ? "sketch" : "filesystem";
    Serial.println("\nOTA Update Started: " + type);
  });

  ArduinoOTA.onEnd([]() {
    Serial.println("\nOTA Update Complete!");
  });

  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    Serial.printf("Progress: %u%%\r", (progress * 100) / total);
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

  Serial.println("\n=================================");
  Serial.println("OTA Ready!");
  Serial.println("Waiting for updates...");
  Serial.println("=================================\n");
}

void loop() {
  ArduinoOTA.handle();
  blinkLED();

  // Print status every 30 seconds
  static unsigned long lastStatus = 0;
  if (millis() - lastStatus > 30000) {
    Serial.print("Running... WiFi: ");
    Serial.print(WiFi.status() == WL_CONNECTED ? "Connected" : "Disconnected");
    Serial.print(" | IP: ");
    Serial.print(WiFi.localIP());
    Serial.print(" | RSSI: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
    lastStatus = millis();
  }

  // Auto-reconnect WiFi if disconnected
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi disconnected! Reconnecting...");
    WiFi.disconnect();
    WiFi.begin(SSID, PSK);
    delay(5000);
  }
}
