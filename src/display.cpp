#include "display.h"
#include <Wire.h>
#include <time.h>
#include "network.h"
#include "watering.h"

// External reference to current commands
extern SystemCommands commands;

DisplayManager Display;

#define OLED_RESET -1

void DisplayManager::init() {
    display = new Adafruit_SH1106G(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

    if (!display) {
        connected = false;
        Serial.println("Display allocation failed!");
        return;
    }

    if (display->begin(OLED_ADDRESS, true)) {
        connected = true;
        display->setRotation(0);  // Landscape mode (128x64)
        display->clearDisplay();
        display->setTextSize(1);
        display->setTextColor(SH110X_WHITE);
        display->setCursor(0, 0);
        display->println("Greenhouse System");
        display->println("Initializing...");
        display->display();
        Serial.println("Display connected");
    } else {
        connected = false;
        Serial.println("Display NOT found");
    }
}

void DisplayManager::clear() {
    if (connected) {
        display->clearDisplay();
        display->display();
    }
}

// Right-align text within a given right-edge x position
static void printRight(Adafruit_SH1106G* d, const char* str, int rightX, int y) {
    int16_t x1, y1; uint16_t w, h;
    d->getTextBounds(str, 0, 0, &x1, &y1, &w, &h);
    d->setCursor(rightX - w, y);
    d->print(str);
}

void DisplayManager::update(const EnvironmentData& env, const PlantState plants[]) {
    if (!connected) return;

    display->clearDisplay();
    display->setTextSize(1);
    display->setTextColor(SH110X_WHITE);

    // ── Status bar (y=0): WiFi | AUTO | PUMP | clock ──────────────────────
    display->setCursor(0, 0);
    display->print(Network.isConnected() ? "WiFi" : "----");

    display->setCursor(30, 0);
    display->print("AUTO");

    bool pumpOn = false;
    for (int i = 0; i < NUM_PLANTS; i++) {
        if (plants[i].valve_open) { pumpOn = true; break; }
    }
    if (pumpOn) {
        display->setCursor(62, 0);
        display->print("PUMP");
    }

    char buf[32];
    struct tm timeinfo;
    if (getLocalTime(&timeinfo, 50)) {
        snprintf(buf, sizeof(buf), "%02d:%02d", timeinfo.tm_hour, timeinfo.tm_min);
    } else {
        strcpy(buf, "--:--");
    }
    printRight(display, buf, 128, 0);

    display->drawLine(0, 9, 128, 9, SH110X_WHITE);

    // ── Row 1 (y=11): current temp (left) + humidity (right) ────────────────
    snprintf(buf, sizeof(buf), "T:%.1fC", env.temperature);
    display->setCursor(0, 11);
    display->print(buf);

    snprintf(buf, sizeof(buf), "H:%.0f%%", env.humidity);
    printRight(display, buf, 128, 11);

    // ── Row 2 (y=21): daily high + low (left-aligned) ───────────────────────
    snprintf(buf, sizeof(buf), "HI:%.1fC LO:%.1fC", env.temp_high, env.temp_low);
    display->setCursor(0, 21);
    display->print(buf);

    // ── Plant boxes (y=31..63): 4 columns of 32px each ─────────────────────
    const int plantStartY = 31;
    const int plantWidth  = 32;
    const int plantHeight = 64 - plantStartY;

    for (int i = 0; i < NUM_PLANTS; i++) {
        int x = i * plantWidth;

        display->drawRect(x, plantStartY, plantWidth, plantHeight, SH110X_WHITE);

        // Plant number label
        display->setCursor(x + 2, plantStartY + 2);
        display->printf("P%d", i + 1);

        if (!commands.plants_active[i]) {
            display->setCursor(x + 6, plantStartY + 13);
            display->print("OFF");
            continue;
        }

        // Moisture value — centred horizontally
        snprintf(buf, sizeof(buf), "%d%%", (int)plants[i].soil_moisture);
        int16_t x1, y1; uint16_t w, h;
        display->getTextBounds(buf, 0, 0, &x1, &y1, &w, &h);
        int textX = x + (plantWidth / 2) - (w / 2);
        int textY = plantStartY + 13;

        if (plants[i].valve_open) {
            display->fillRect(x + 1, textY - 1, plantWidth - 2, h + 2, SH110X_WHITE);
            display->setTextColor(SH110X_BLACK);
            display->setCursor(textX, textY);
            display->print(buf);
            display->setTextColor(SH110X_WHITE);
        } else {
            display->setCursor(textX, textY);
            display->print(buf);
        }

        // Progress bar at bottom of box
        int barY     = 64 - 4;
        int barWidth = plantWidth - 4;
        int fillWidth = (plants[i].progress_percent * barWidth) / 100;
        display->drawRect(x + 2, barY, barWidth, 3, SH110X_WHITE);
        display->fillRect(x + 2, barY, fillWidth, 3, SH110X_WHITE);
    }

    display->display();
}
