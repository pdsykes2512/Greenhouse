#include <Arduino.h>
#include <math.h>
#include <time.h>
#include <Timezone.h>

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiUdp.h>
#include <ArduinoOTA.h>
#include <NTPClient.h>
#include <TelnetStream.h>

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>
#include <SHT31.h>
#include <OneWire.h>
#include <DallasTemperature.h>

#include "config.h"

// Debug setup
#ifdef TELNET_DEBUG
#define SerialDebug TelnetStream
#else
#define SerialDebug Serial
#endif

#define SERIAL_DEBUG true

// Setup I2C for display and SHT sensor
#define OLED_RESET -1
#define ONEWIRE_PIN D12
Adafruit_SH1106G display = Adafruit_SH1106G(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
SHT31 sht;
// OneWire oneWire(ONEWIRE_PIN);
// DallasTemperature soilTemp(&oneWire);

// Define global variables
uint32_t connectionFails = 0;
float temperature;
float humidity;
float temp_high;
float temp_low = 100;
uint8_t timer;
bool display_connected = false;

// Setup time
bool init_ntp = true;
long ontime, offtime;
unsigned long last_millis = 0;
bool ntp_update;
unsigned long _last_rtc = 0;
unsigned long _last_millis = 0;
uint32_t moment;

// Set up Timezone
TimeChangeRule BST = {"BST", Last, Sun, Mar, 1, 60}; // British Summer Time
TimeChangeRule GMT = {"GMT", Last, Sun, Oct, 2, 0};  // Standard Time
Timezone UK(BST, GMT);

// Set up networking
WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP);
WiFiClient wifiClient; // Must be global or it will cause resets!
const char *ssid = SSID;
const char *password = PSK;

// Set up plants
typedef struct
{
  bool active;             // Active (true,false). Set to false to stop watering
  uint8_t temp_sensor;     // Read DS18B20 temp sensor
  uint8_t soil_pin;        // Soil ZGPIO Sensor
  uint8_t valve_relay;     // Pump relay #
  uint32_t water_time_on;  // Water Time On
  uint32_t water_time_off; // Water Time Off
  bool water_level_sensor; // Pointer to Water Level Sensor
  float soil_moisture_dry; // Dry Soil Moisture Percentage
  float soil_moisture_wet; // Wet Soil Moisture Percentage
} PLANT_CONFIG_t;

PLANT_CONFIG_t plant_config_table[] = {
    {PLANT1_ACTIVE, // Plant 1
     TEMP1_SENSOR,
     SOIL1_PIN,
     VALVE1_RELAY,
     PLANT1_WATER_ON,
     PLANT1_WATER_OFF,
     WATER1_LEVEL_SENSOR,
     PLANT1_SOIL_DRY,
     PLANT1_SOIL_WET},
    {PLANT2_ACTIVE, // Plant 2
     TEMP2_SENSOR,
     SOIL2_PIN,
     VALVE2_RELAY,
     PLANT2_WATER_ON,
     PLANT2_WATER_OFF,
     WATER1_LEVEL_SENSOR,
     PLANT2_SOIL_DRY,
     PLANT2_SOIL_WET},
    {PLANT3_ACTIVE, // Plant 3
     TEMP3_SENSOR,
     SOIL3_PIN,
     VALVE3_RELAY,
     PLANT3_WATER_ON,
     PLANT3_WATER_OFF,
     WATER1_LEVEL_SENSOR,
     PLANT3_SOIL_DRY,
     PLANT3_SOIL_WET},
    {PLANT4_ACTIVE, // Plant 4
     TEMP4_SENSOR,
     SOIL4_PIN,
     VALVE4_RELAY,
     PLANT4_WATER_ON,
     PLANT4_WATER_OFF,
     WATER1_LEVEL_SENSOR,
     PLANT4_SOIL_DRY,
     PLANT4_SOIL_WET}};

#define NUMBER_OF_PLANTS (sizeof(plant_config_table) / sizeof(PLANT_CONFIG_t))

typedef struct
{
  float soil_moisture;      // Soil Moisture Percentage
  bool soil_moisture_error; // Error Reading Soil Moisture Sensor
  float soil_temp;          // Current Soil Temperature
  bool soil_temp_error;     // Error Reading Soil Temperature
  bool valve_state;         // Water valve state (OFF,ON,WAIT)
  uint32_t valve_timer;     // Water valve timer
  bool water_level;         // Current Water Level (true,false)
  uint8_t progress_bar;     // Water Progress Bar Level
} PLANT_t;

PLANT_t plant_table[NUMBER_OF_PLANTS];

PLANT_CONFIG_t *plant_config = plant_config_table;
PLANT_t *plant = plant_table;

// Humidity conversion function
#define MOLAR_MASS_OF_WATER 18.01534
#define UNIVERSAL_GAS_CONSTANT 8.21447215

float AbsoluteHumidity(float temp, float relative)
{
  // taken from https://carnotcycle.wordpress.com/2012/08/04/how-to-convert-relative-humidity-to-absolute-humidity/
  // precision is about 0.1°C in range -30 to 35°C
  // August-Roche-Magnus   6.1094 exp(17.625 x T)/(T + 243.04)
  // Buck (1981)     6.1121 exp(17.502 x T)/(T + 240.97)
  // reference https://www.eas.ualberta.ca/jdwilson/EAS372_13/Vomel_CIRES_satvpformulae.html    // Use Buck (1981)
  return (6.1121 * pow(2.718281828, (17.67 * temp) / (temp + 243.5)) * relative * MOLAR_MASS_OF_WATER) / ((273.15 + temp) * UNIVERSAL_GAS_CONSTANT);
}

void WiFiConnected(WiFiEvent_t event, WiFiEventInfo_t info){
  SerialDebug.println("Connected to AP successfully!");
}

void WiFiGotIP(WiFiEvent_t event, WiFiEventInfo_t info){
  SerialDebug.println("WiFi connected");
  SerialDebug.println("IP address: ");
  SerialDebug.println(WiFi.localIP());
}

void WiFiDisconnected(WiFiEvent_t event, WiFiEventInfo_t info){
  #ifdef SERIAL_DEBUG
    SerialDebug.println("Disconnected from WiFi access point");
    SerialDebug.print("WiFi lost connection. Reason: ");
    SerialDebug.println(info.wifi_sta_disconnected.reason);
    SerialDebug.println("Trying to Reconnect");
  #endif
  WiFi.begin(ssid, password);
}

// Initialise WiFi function
void initWiFi(uint8_t wait)
{
  // Delete old config
  WiFi.disconnect(true);

  delay(1000);

  WiFi.onEvent(WiFiConnected, WiFiEvent_t::ARDUINO_EVENT_WIFI_STA_CONNECTED);
  WiFi.onEvent(WiFiGotIP, WiFiEvent_t::ARDUINO_EVENT_WIFI_STA_GOT_IP);
  WiFi.onEvent(WiFiDisconnected, WiFiEvent_t::ARDUINO_EVENT_WIFI_STA_DISCONNECTED);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  #ifdef SERIAL_DEBUG
    SerialDebug.print("\r\nConnecting to WiFi...");
  #endif
}

// Post data to database via http function
void httpPost(const char *url, String &post_data)
{
  HTTPClient http;
  http.begin(wifiClient, url);
  http.addHeader("Content-Type", "application/x-www-form-urlencoded");

  // SerialDebug.println(post_data);
  int http_code = http.POST(post_data); // Send the request
  String payload = http.getString();    // Get the response payload

  // SerialDebug.println(http_code);  // Print HTTP return code
  // SerialDebug.println(payload);    // Print request response payload

  if (payload.length() > 0)
  {
    int index = 0;
    do
    {
      if (index > 0)
        index++;
      int next = payload.indexOf('\n', index);
      if (next == -1)
        break;
      String request = payload.substring(index, next);
      if (request.substring(0, 9).equals("<!DOCTYPE"))
        break;

      index = next;
    } while (index >= 0);
  }

  http.end(); // Close connection
}

// Function to allow delays but maintain OTA update ability
void delayOTA(int duration)
{
  moment = millis();
  while (millis() - moment < duration)
  {
    ArduinoOTA.handle();
    yield();
  }
}

struct VH400 {
  double analogValue;
  double analogValue_sd;
  double voltage;
  double voltage_sd;
  double VWC;
  double VWC_sd;
};

struct VH400 readVH400(int analogPin, int nMeasurements, int delayBetweenMeasurements) {
  // This variant calculates the mean and standard deviation of 100 measurements over 5 seconds.
  // It reports mean and standard deviation for the analog value, voltage, and WVC. Taken from
  // https://gist.github.com/lx-88/413b48ced6b79300ea76
  
  // This function returns Volumetric Water Content by converting the analogPin value to voltage
  // and then converting voltage to VWC using the piecewise regressions provided by the manufacturer
  // at http://www.vegetronix.com/Products/VH400/VH400-Piecewise-Curve.phtml
  
  // NOTE: You need to set analogPin to input in your setup block
  //   ex. pinMode(<analogPin>, INPUT);
  //   replace <analogPin> with the number of the pin you're going to read from.

  struct VH400 result;
  
  // Sums for calculating statistics
  int sensorDNsum = 0;
  double sensorVoltageSum = 0.0;
  double sensorVWCSum = 0.0;
  double sqDevSum_DN = 0.0;
  double sqDevSum_volts = 0.0;
  double sqDevSum_VWC = 0.0;

  // Arrays to hold multiple measurements
  int sensorDNs[nMeasurements];
  double sensorVoltages[nMeasurements];
  double sensorVWCs[nMeasurements];

  // Make measurements and add to arrays
  for (int i = 0; i < nMeasurements; i++) { 
    // Read value and convert to voltage 
    int sensorDN = analogRead(analogPin);
    double sensorVoltage = sensorDN*(3.0 / 4095.0);
        
    // Calculate VWC
    float VWC;
    if (sensorVoltage <= 1.1)
    {
      VWC = 10 * sensorVoltage - 1;
    }
    else if (sensorVoltage > 1.1 && sensorVoltage <= 1.3)
    {
      VWC = 25 * sensorVoltage - 17.5;
    }
    else if (sensorVoltage > 1.3 && sensorVoltage <= 1.82)
    {
      VWC = 48.08 * sensorVoltage - 47.5;
    }
    else if (sensorVoltage > 1.82)
    {
      VWC = 26.32 * sensorVoltage - 7.89;
    }

    // Add to statistics sums
    sensorDNsum += sensorDN;
    sensorVoltageSum += sensorVoltage;
    sensorVWCSum += VWC;

    // Add to arrays
    sensorDNs[i] = sensorDN;
    sensorVoltages[i] = sensorVoltage;
    sensorVWCs[i] = VWC;

    // Wait for next measurement
    delay(delayBetweenMeasurements);
  }

  // Calculate means
  double DN_mean = double(sensorDNsum)/double(nMeasurements);
  double volts_mean = sensorVoltageSum/double(nMeasurements);
  double VWC_mean = sensorVWCSum/double(nMeasurements);

  // Loop back through to calculate SD
  for (int i = 0; i < nMeasurements; i++) { 
    sqDevSum_DN += pow((DN_mean - double(sensorDNs[i])), 2);
    sqDevSum_volts += pow((volts_mean - double(sensorVoltages[i])), 2);
    sqDevSum_VWC += pow((VWC_mean - double(sensorVWCs[i])), 2);
  }
  double DN_stDev = sqrt(sqDevSum_DN/double(nMeasurements));
  double volts_stDev = sqrt(sqDevSum_volts/double(nMeasurements));
  double VWC_stDev = sqrt(sqDevSum_VWC/double(nMeasurements));

  // Setup the output struct
  result.analogValue = DN_mean;
  result.analogValue_sd = DN_stDev;
  result.voltage = volts_mean;
  result.voltage_sd = volts_stDev;
  result.VWC = VWC_mean;
  result.VWC_sd = VWC_stDev;

  // Return the result
  return(result);
}

// Read plant sensor function
void readSensors(uint8_t p)
{
  // Read temperature sensor
  // soilTemp.requestTemperatures();
  // plant[plant_no].soil_temp = soilTemp.getTempCByIndex(plant_config[plant_no].temp_sensor);
  int moistureReading;
  float moistureVoltage;
  plant[p].soil_temp = 0;

  // Read moisture sensor
  pinMode(plant_config[p].soil_pin, INPUT_PULLDOWN);
  delayOTA(100);
  if (plant_config[p].active)
  {
    if (analogRead(plant_config[p].soil_pin) < 100)
    { // Set value to zero if no sensor detected
      plant[p].soil_moisture = 0;
    }
    else
    { // Otherwise read sensor again for accurate value
      pinMode(plant_config[p].soil_pin, INPUT);
      delayOTA(100);
      plant[p].soil_moisture = readVH400(plant_config[p].soil_pin, 100, 50).VWC;
    }
  }
  else
  {
    plant[p].soil_moisture = 0;
  }
}

// Update pump and relay conditions function
void waterControl()
{
  uint8_t p;
  SerialDebug.println();

  // Check whether pump should be on/off
  bool pump_state = closed;
  for (p = 0; p < NUMBER_OF_PLANTS; p++)
  {
    if (plant[p].valve_state == open && plant_config[p].active)
    {
      pump_state = open;
    }
  }

  // Turn pump off if not requires and update valves as per plant states
  if (pump_state == open)
  {
    for (p = 0; p < NUMBER_OF_PLANTS; p++)
    {
      if (plant_config[p].active)
      {
        digitalWrite(plant_config[p].valve_relay, plant[p].valve_state);
        SerialDebug.printf("Valve %i: %d\t", p + 1, plant[p].valve_state);
      }
    }
    delayOTA(500);
    digitalWrite(PUMP_RELAY, open);
    SerialDebug.println("Pump ON");
  }
  // Otherwise update valves as per plant states and turn pump on
  else
  {
    digitalWrite(PUMP_RELAY, closed);
    delayOTA(2000);
    for (p = 0; p < NUMBER_OF_PLANTS; p++)
    {
      digitalWrite(plant_config[p].valve_relay, plant[p].valve_state);
      SerialDebug.printf("Valve %i: %d\t", p + 1, plant[p].valve_state);
    }
    SerialDebug.println("Pump OFF\t");
  }
}

// Refresh OLED display
void updateDisplay()
{
  uint8_t i, j;
  int16_t x, y, x1, y1;
  uint16_t w, h;
  int16_t height = 3;
  float width;
  String buf;

  if (!display_connected)
  {

    SerialDebug.print("Display not found...\n");
  }
  else
  {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SH110X_WHITE);
    display.setCursor(0, 0);

    // Display Temp & Humidity
    display.printf("Temperature: %.1fC\nL: %.1fC  H: %.1fC\n", temperature, temp_low, temp_high);
    display.printf("Humidity: %.1f%%\n\n", humidity);

    // Display temperature values
    // for (i = 0; i < NUMBER_OF_PLANTS; i++) {
    //  display.printf("%.0fC  ", plant[i].soil_temp);
    //}
    // display.println();

    // Display humidity values
    for (i = 0; i < NUMBER_OF_PLANTS; i++)
    {
      if (plant_config[i].active)
      {
        x = i * (float(display.width()) / 4);
        y = display.height() - height;
        width = (float(plant[i].progress_bar) / 100) * (float(display.width() / 4));
        buf = int(plant[i].soil_moisture);
        buf += "%";
        display.getTextBounds(buf, x, y - 7, &x1, &y1, &w, &h);
        display.setCursor(x + float(display.width() / 8) - float(w / 2), y - (h + 1));
        if (plant[i].valve_state == open)
        {
          display.setTextColor(SH110X_BLACK);
          display.fillRect(x, y - (h + 3), display.width() / 4, h + 2, SH110X_WHITE);
          display.print(buf);
          display.setTextColor(SH110X_WHITE);
        }
        else
        {
          display.print(buf);
        }
        display.fillRect(x, y - 1, width, height, SH110X_WHITE);
        display.drawRect(x, y - (h + 3), display.width() / 4, height + h + 3, SH110X_WHITE);
      }
    }
    display.println();
    display.display();
  }
}

// Program setup
void setup()
{
  // Initialise WiFi connection
  #ifdef TELNET_DEBUG
    initWiFi(10);           // Initialise WiFi before telnet debug serial is set up or boot will stall
    SerialDebug.begin();
  #else
    SerialDebug.begin(115200);
    initWiFi(10);
  #endif

  SerialDebug.println("\r\nSoil Moisture Control System");

  // Allow OTA updates
  ArduinoOTA.setHostname(SYSTEM_HOSTNAME);
  ArduinoOTA.setPassword(FLASH_PWD);

  ArduinoOTA.onStart([]()
    {
      String type;
      if (ArduinoOTA.getCommand() == U_FLASH) {
        type = "sketch";
      } else {  // U_SPIFFS
        type = "filesystem";
      }
      // NOTE: if updating SPIFFS this would be the place to unmount SPIFFS using SPIFFS.end()
      SerialDebug.println("\nStart updating..." + type);
    });
  ArduinoOTA.onEnd([]()
    {
      SerialDebug.println("\nEnd");
    });
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total)
    {
      SerialDebug.printf("Progress: %u%%\r", (progress / (total / 100)));
    });
  ArduinoOTA.onError([](ota_error_t error)
    {
      SerialDebug.printf("Error[%u]: ", error);
      if (error == OTA_AUTH_ERROR) {
        SerialDebug.println("Auth Failed");
      } else if (error == OTA_BEGIN_ERROR) {
        SerialDebug.println("Begin Failed");
      } else if (error == OTA_CONNECT_ERROR) {
        SerialDebug.println("Connect Failed");
      } else if (error == OTA_RECEIVE_ERROR) {
        SerialDebug.println("Receive Failed");
      } else if (error == OTA_END_ERROR) {
        SerialDebug.println("End Failed");
      }
    });
  ArduinoOTA.begin();

  // Connect to NTP time server to update RTC clock
  timeClient.begin();
  ntp_update = timeClient.update();

  // Serial.begin(115200);
  Wire.begin();
  delay(250); // wait for the OLED to power up

  // Initialise display
  if (display.begin(OLED_ADDRESS, true))
  {
    display_connected = true;
    display.display();
  }

  // Initialise Temp/Hum sensor
  sht.begin();
  uint16_t stat = sht.readStatus();
  SerialDebug.print(stat, HEX);
  SerialDebug.println();

  // Setup pins

  // //soilTemp.begin();
  pinMode(PUMP_RELAY, OUTPUT);
  digitalWrite(PUMP_RELAY, closed);

  uint8_t v;
  for (v = 0; v < NUMBER_OF_PLANTS; v++)
  {
    // Setup valve relay pins
    pinMode(plant_config[v].valve_relay, OUTPUT);      // Set pin for relay operation
    digitalWrite(plant_config[v].valve_relay, closed); // Turn relay off
    plant[v].valve_state == closed;
  }
}

// Main program
void loop()
{
  uint8_t i, j;
  static tm clk, local;
  time_t ntp_time, clk_time;
  char buffer[80];
  String post_data;
  unsigned long ntp_millis, now_millis;
  static uint8_t last_min = -1;
  static uint8_t last_sec = -1;
  bool update_water = false;
  uint32_t waterProgress;
  float a, b;

  ArduinoOTA.handle();

  if (init_ntp)
  {
    timeClient.update();
    ntp_time = timeClient.getEpochTime();
    ntp_millis = millis();
  }

  // Get the current date/time
  clk_time = ntp_time + ((millis() - ntp_millis) / 1000);
  gmtime_r(&clk_time, &clk);

  time_t local_time = UK.toLocal(clk_time);
  gmtime_r(&local_time, &local);

  // Process every minute
  if (clk.tm_min != last_min)
  {
    timer = 0;

    if (sht.isConnected())
    {
      bool b = sht.read();

      int error = sht.getError();
      uint16_t stat = sht.readStatus();

      temperature = sht.getTemperature();
      humidity = sht.getHumidity();

      if (temperature > temp_high)
      {
        temp_high = temperature;
      }

      if (temperature < temp_low)
      {
        temp_low = temperature;
      }

      // Output readings to debug
      SerialDebug.printf("\nTemperature: %.1fC (Low: %.1fC  High: %.1fC), ", temperature, temp_low, temp_high);
      SerialDebug.printf("Humidity: %.1f%%\n", humidity);
      // int deviceCount = soilTemp.getDeviceCount();
      // SerialDebug.printf("Devices: %i\n", deviceCount);
    }
    else
    {
      connectionFails++;
      SerialDebug.printf("\nSHT Not connected:\t%u\n", connectionFails);
    }

    // Read sensors sensors
    for (i = 0; i < NUMBER_OF_PLANTS; i++)
    {
      readSensors(i);
      // SerialDebug.printf("Plant %i: %.1f%%\t", i + 1, plant[i].soil_moisture);
    }

    // Turn relays on
    for (i = 0; i < NUMBER_OF_PLANTS; i++)
    {
      if ((plant[i].soil_moisture < plant_config[i].soil_moisture_dry) && (plant_config[i].active) && (plant[i].valve_state == closed) && (((millis() - plant[i].valve_timer) / 1000) > plant_config[i].water_time_off))
      {
        plant[i].valve_state = open;
        plant[i].water_level = 1;
        update_water = true;
        plant[i].valve_timer = millis();
      }
    }
    if (update_water)
    {
      waterControl(); // Update pump and valve status
      update_water = false;
    }

    // Create post string and post to database
    strftime(buffer, sizeof(buffer), "%m/%d/%Y %H:%M:%S", &clk);
    post_data = "data={";
    post_data += "\"ReadingTime\":\"" + String(buffer) + "\"";
    post_data += ",\"Temp\":";
    post_data += temperature;
    post_data += ",\"Relative\":";
    post_data += humidity;
    post_data += ",\"Absolute\":";
    post_data += AbsoluteHumidity(temperature, humidity);
    post_data += ",\"Plant\":[";
    for (i = 0; i < NUMBER_OF_PLANTS; i++)
    {
      post_data += "{\"SoilTemp\":";
      post_data += plant[i].soil_temp;
      post_data += ",\"SoilMoisture\":";
      post_data += plant[i].soil_moisture;
      post_data += ",\"WaterLevel\":";
      post_data += plant[i].water_level;
      if (i != (NUMBER_OF_PLANTS - 1))
      {
        post_data += "},";
      }
    }
    post_data += "}]}";

    httpPost(mysql_url, post_data);

    updateDisplay(); // Update OLED display

    last_min = clk.tm_min; // Update timer related variables
  }

  // Process every second
  if (clk.tm_sec != last_sec)
  {
    SerialDebug.printf("Timer: %u\t", clk.tm_sec);

    // Turn relays off when timer reached
    for (i = 0; i < NUMBER_OF_PLANTS; i++)
    {
      if (plant[i].valve_state == open)
      {
        if (plant_config[i].active)
        {
          readSensors(i);
        }
        if (((millis() - plant[i].valve_timer) / 1000 > plant_config[i].water_time_on) || (plant[i].soil_moisture > plant_config[i].soil_moisture_wet))
        {
          plant[i].valve_state = closed;
          plant[i].water_level = 0;
          plant[i].valve_timer = millis();
          update_water = true;
        }
        a = timer;
        b = plant_config[i].water_time_on;
        if (b - a > 0)
        {
          waterProgress = 100 * float((b - a) / b);
          plant[i].progress_bar = waterProgress;
        }
        else
        {
          plant[i].progress_bar = 0;
        }
      }
      else
      {
        a = (millis() - plant[i].valve_timer) / 1000;
        b = plant_config[i].water_time_off;
        waterProgress = 100 * float(a / b);
        if (waterProgress > 100)
        {
          plant[i].progress_bar = 100;
        }
        else
        {
          plant[i].progress_bar = waterProgress;
          // SerialDebug.printf("\nProgress: %i/%i = %i\n", a, b, plant[i].progress_bar);
        }
      }
      SerialDebug.printf("Plant %i: %.1f%%, %i, %i%%\t", i + 1, plant[i].soil_moisture, plant[i].water_level, plant[i].progress_bar);
    }
    updateDisplay(); // Update OLED display
    SerialDebug.print("\r");
    if (update_water)
    {
      waterControl(); // Update pump and valve status
      update_water = false;
    }

    // Update timer related variables
    last_sec = clk.tm_sec;
    timer++;
  }
}