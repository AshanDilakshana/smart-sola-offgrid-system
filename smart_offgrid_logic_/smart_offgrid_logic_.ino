#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFi.h>          
#include <WiFiUdp.h>
#include <NTPClient.h>
#include <RTClib.h>        
#include <WebServer.h>     
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <WiFiClientSecure.h>
#include "JK_BMS.h"

JKBMS jkbms;
unsigned long lastBmsRequest = 0;

// OLED Display Settings
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// RTC Setting
RTC_DS3231 rtc;

// WiFi Credentials
const char* ssid = "SLT FIBER";
const char* password = "@Ashan20030118";

// Firmware Versioning
const char* FIRMWARE_VERSION = "v1.0.5";

// NTP Time Client
WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "pool.ntp.org", 19800, 60000);

// Web Server on Port 80
WebServer server(80);

// ---------------------------------------------------------
// ESP32 PIN Definitions
// ---------------------------------------------------------
const int SOLAR_PIN   = 32; 

const int INV_RELAY   = 25;   
const int SMPS_RELAY  = 26;   
const int GRID_SENS   = 33;   

const int ECO_SWITCH    = 14; 
const int PCUT_SWITCH   = 27; 
const int MANUAL_SWITCH = 13; 


// --- Easy Timer Configuration ---
const unsigned long TIMER_DELAY_MS = 180000; 
const int TIMER_DELAY_SEC = 180;

// --- Charging Voltage Configuration ---
const float BAT_CHARGE_START_THRESHOLD = 12.5; // Start normal charging below this voltage (Default: 12.5V)
const float BAT_CHARGE_STOP_THRESHOLD  = 15.5; // Stop charging when battery reaches this voltage (Below inverter OVP 15.5V)
const float BAT_TOPUP_START_THRESHOLD  = 14.5; // Start top-up charging if battery drops below this voltage

// Timer, Toggle & State Variables
unsigned long powerCutTime = 0;
unsigned long gridReturnTime = 0;
unsigned long statusToggleTime = 0;
bool powerCutTimerActive = false;
bool gridReturnTimerActive = false;
bool inverterState = false;
bool smpsState = false;
bool topup530Active = false;
bool topup1amActive = false;
bool normalChargingActive = false;
bool topup530Done = false;         // Prevents evening top-up from looping
bool topup1amDone = false;         // Prevents morning top-up from looping
int statusPage = 0; 
String currentModeString = "POWER OFF";

// Web Control & Override Variables
// webModeOverride: -1 = Auto (Physical Switches), 0 = POWER OFF, 1 = ECO MODE, 2 = POWER CUT, 3 = ECO+POWER CUT, 4 = MANUAL
int webModeOverride = -1;
bool forceChargingActive = false;
bool manualInverterOverride = false;
bool manualSmpsOverride = false;

// --- Flatline Detection (dV/dt) Variables ---
unsigned long lastVoltageCheckTime = 0;
float lastRecordedVoltage = 0.0;
bool flatlineDetected = false;
const unsigned long VOLTAGE_CHECK_INTERVAL = 300000; // 5 minutes (300,000 ms)
const float DVDT_START_VOLTAGE = 13.5; // Only check after reaching 13.5V

// --- Software Grid Debounce Variables ---
unsigned long lastGridDebounceTime = 0;
bool lastGridRawState = false;
bool debouncedGridState = false;
const unsigned long GRID_DEBOUNCE_DELAY_MS = 1000; // 1 second debounce to filter grid noise

// --- Super Strong Noise Filter Variables ---
float lastBatVolt = 0.0;
float lastSolVolt = 0.0;

// Function declarations for API
void handleGetStatus();
void handleSetMode();
void handleSetCharge();
void handleSetRelay();
void handleOTAUpdate();
void syncFirebaseTask(void * pvParameters);

unsigned long lastAppHeartbeatTime = 0;
String lastReceivedHeartbeatStr = ""; // To track if the heartbeat timestamp actually changed
const unsigned long ACTIVE_SESSION_TIMEOUT_MS = 10800000; // 3 Hours (10,800,000 ms)
bool isAppSessionActive = true;
TaskHandle_t FirebaseTaskHandle;

// --- 15-Minute Periodic History Logging ---
unsigned long lastHistoryLogTime = 0;
const unsigned long HISTORY_LOG_INTERVAL = 900000; // 15 minutes (900,000 ms)

void setup() {
  Serial.begin(115200);

  // Initialize JK BMS on Serial2 (RX=4, TX=5)
  jkbms.begin(Serial2, 4, 5);

  // ADC Settings
  analogSetAttenuation(ADC_11db);

  // Active-Low Relay Boot Glitch Fix 
  digitalWrite(INV_RELAY, HIGH);
  digitalWrite(SMPS_RELAY, HIGH);
  pinMode(INV_RELAY, OUTPUT);
  pinMode(SMPS_RELAY, OUTPUT);

  // Sensing and Switch Pins
  pinMode(GRID_SENS, INPUT);
  pinMode(ECO_SWITCH, INPUT_PULLUP);
  pinMode(PCUT_SWITCH, INPUT_PULLUP);
  pinMode(MANUAL_SWITCH, INPUT_PULLUP);

  // Initialize OLED
  if(!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) { 
    Serial.println(F("SSD1306 allocation failed"));
    for(;;);
  }
  display.clearDisplay();
  display.display();

  // Initialize RTC
  if (!rtc.begin()) {
    Serial.println("RTC Not Found!");
  }

  // Initialize debounced grid state to avoid 1-second false power-cut at boot
  lastGridRawState = digitalRead(GRID_SENS);
  debouncedGridState = lastGridRawState;

  // Connect to WiFi
  WiFi.begin(ssid, password);
  timeClient.begin();

  // Configure Web Server & CORS
  server.enableCORS(true);
  server.on("/api/status", HTTP_GET, handleGetStatus);
  server.on("/api/mode", HTTP_POST, handleSetMode);
  server.on("/api/mode", HTTP_GET, handleSetMode);
  server.on("/api/charge", HTTP_POST, handleSetCharge);
  server.on("/api/charge", HTTP_GET, handleSetCharge);
  server.on("/api/relay", HTTP_POST, handleSetRelay);
  server.on("/api/relay", HTTP_GET, handleSetRelay);
  server.on("/api/ota-update", HTTP_POST, handleOTAUpdate);
  server.on("/api/ota-update", HTTP_GET, handleOTAUpdate);
  server.begin();
  Serial.println("HTTP Web Server Started");

  // Start Firebase Cloud Sync as a FreeRTOS Background Task on Core 0 (Network Core)
  // This prevents the slow HTTPS handshakes from blocking the main loop (OLED & Switches)
  xTaskCreatePinnedToCore(
    syncFirebaseTask,   // Task function
    "FirebaseTask",     // Name of task
    8192,               // Stack size (8KB for HTTPS)
    NULL,               // Parameter
    1,                  // Priority
    &FirebaseTaskHandle,// Task handle
    0                   // Pin to Core 0
  );
}

// ---------------------------------------------------------
// 🛠️ NOISE FILTERED VOLTAGE FUNCTIONS
// ---------------------------------------------------------
float getBatteryVoltage() {
  // Return the voltage parsed from the JK BMS
  if (jkbms.dataValid) {
    lastBatVolt = jkbms.voltage;
  }
  return lastBatVolt;
}

float getSolarVoltage() {
  // Solar panels are disconnected. Return 0.0V to prevent floating pin readings.
  return 0.0;
}

// ---------------------------------------------------------
// Draw WiFi Signal Bars
// ---------------------------------------------------------
void drawWiFiBars(int x, int y) {
  if (WiFi.status() != WL_CONNECTED) {
    display.setCursor(x, y);
    display.setTextSize(1);
    display.print("X");
    return;
  }
  long rssi = WiFi.RSSI();
  int bars = 0;
  if (rssi > -55) bars = 4;
  else if (rssi <= -55 && rssi > -65) bars = 3;
  else if (rssi <= -65 && rssi > -75) bars = 2;
  else if (rssi <= -75 && rssi >= -85) bars = 1;
  
  if (bars >= 1) display.fillRect(x,     y + 6, 2, 2, SSD1306_WHITE);
  if (bars >= 2) display.fillRect(x + 3, y + 4, 2, 4, SSD1306_WHITE);
  if (bars >= 3) display.fillRect(x + 6, y + 2, 2, 6, SSD1306_WHITE);
  if (bars >= 4) display.fillRect(x + 9, y,     2, 8, SSD1306_WHITE);
}

// ---------------------------------------------------------
// 🌐 WEB SERVER API HANDLERS
// ---------------------------------------------------------
void handleGetStatus() {
  String json = "{";
  json += "\"batteryVoltage\":" + String(lastBatVolt, 2) + ",";
  json += "\"batteryCurrent\":" + String(jkbms.current, 2) + ",";
  json += "\"batterySoc\":" + String(jkbms.soc) + ",";
  json += "\"cellVoltages\":[" + String(jkbms.cellVoltages[0], 3) + "," + String(jkbms.cellVoltages[1], 3) + "," + String(jkbms.cellVoltages[2], 3) + "," + String(jkbms.cellVoltages[3], 3) + "],";
  json += "\"solarVoltage\":" + String(lastSolVolt, 2) + ",";
  json += "\"gridPresent\":" + String(debouncedGridState ? "true" : "false") + ",";
  json += "\"inverterState\":" + String(inverterState ? "true" : "false") + ",";
  json += "\"smpsState\":" + String(smpsState ? "true" : "false") + ",";
  json += "\"modeString\":\"" + currentModeString + "\",";
  json += "\"webModeOverride\":" + String(webModeOverride) + ",";
  json += "\"forceChargingActive\":" + String(forceChargingActive ? "true" : "false") + ",";
  json += "\"topup530Active\":" + String(topup530Active ? "true" : "false") + ",";
  json += "\"topup1amActive\":" + String(topup1amActive ? "true" : "false") + ",";
  json += "\"normalChargingActive\":" + String(normalChargingActive ? "true" : "false") + ",";
  json += "\"flatlineDetected\":" + String(flatlineDetected ? "true" : "false") + ",";
  json += "\"wifiConnected\":" + String(WiFi.status() == WL_CONNECTED ? "true" : "false") + ",";
  json += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  json += "\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) + "\"";
  json += "}";
  server.send(200, "application/json", json);
}

void handleSetMode() {
  if (server.hasArg("mode")) {
    webModeOverride = server.arg("mode").toInt();
  }
  server.send(200, "application/json", "{\"success\":true,\"webModeOverride\":" + String(webModeOverride) + "}");
}

void handleSetCharge() {
  if (server.hasArg("active")) {
    String act = server.arg("active");
    forceChargingActive = (act == "true" || act == "1");
  } else {
    forceChargingActive = !forceChargingActive;
  }
  server.send(200, "application/json", "{\"success\":true,\"forceChargingActive\":" + String(forceChargingActive ? "true" : "false") + "}");
}

void handleSetRelay() {
  if (server.hasArg("inverter")) {
    manualInverterOverride = (server.arg("inverter") == "true" || server.arg("inverter") == "1");
  }
  if (server.hasArg("smps")) {
    manualSmpsOverride = (server.arg("smps") == "true" || server.arg("smps") == "1");
  }
  server.send(200, "application/json", "{\"success\":true}");
}

void handleOTAUpdate() {
  if (!server.hasArg("url")) {
    server.send(400, "application/json", "{\"error\":\"Missing firmware URL parameter\"}");
    return;
  }
  String firmwareUrl = server.arg("url");
  server.send(200, "application/json", "{\"success\":true,\"message\":\"Starting OTA update from GitHub...\"}");
  
  WiFiClientSecure client;
  client.setInsecure(); // Skip HTTPS cert check for GitHub raw binary download
  
  t_httpUpdate_return ret = httpUpdate.update(client, firmwareUrl);
  if (ret == HTTP_UPDATE_OK) {
    Serial.println("OTA Update Successful! Restarting ESP32...");
  } else {
    Serial.printf("OTA Update Failed. Error (%d): %s\n", httpUpdate.getLastError(), httpUpdate.getLastErrorString().c_str());
  }
}

// ---------------------------------------------------------
// 🌐 GLOBAL FIREBASE CLOUD REALTIME SYNC (FREE RTOS TASK)
// ---------------------------------------------------------
void syncFirebaseTask(void * pvParameters) {
  // Create HTTP and Secure Client objects once outside the loop to prevent memory fragmentation
  HTTPClient http;
  WiFiClientSecure client;
  client.setInsecure(); // Required for ESP32 to bypass HTTPS certificate validation

  for (;;) {
    if (WiFi.status() == WL_CONNECTED) {
      http.setTimeout(3000);

      // 1. Fetch pending global web commands & app heartbeat from Firebase
      String commandUrl = "https://my-smart-off-grid-default-rtdb.firebaseio.com/commands.json";
      http.begin(client, commandUrl); // Use WiFiClientSecure
      int httpCode = http.GET();
      
      if (httpCode == 200) {
        String payload = http.getString();
        
        // Parse webModeOverride if present
        int modeIdx = payload.indexOf("\"webModeOverride\":");
        if (modeIdx != -1) {
          int val = payload.substring(modeIdx + 18).toInt();
          if (val >= -1 && val <= 4) webModeOverride = val;
        }
        
        // Parse forceChargingActive if present
        int chargeIdx = payload.indexOf("\"forceChargingActive\":");
        if (chargeIdx != -1) {
          String valStr = payload.substring(chargeIdx + 22, chargeIdx + 27);
          forceChargingActive = (valStr.indexOf("true") != -1);
        }
        
        // Parse lastHeartbeat / app active ping (Only reset timer if value CHANGED)
        int hbIdx = payload.indexOf("\"lastHeartbeat\":");
        if (hbIdx != -1) {
          int commaIdx = payload.indexOf(",", hbIdx);
          if (commaIdx == -1) commaIdx = payload.indexOf("}", hbIdx);
          if (commaIdx != -1) {
            String hbValue = payload.substring(hbIdx + 16, commaIdx);
            if (hbValue != lastReceivedHeartbeatStr) {
               lastReceivedHeartbeatStr = hbValue; // Update tracker
               lastAppHeartbeatTime = millis();    // Reset the 3-hour timeout timer
            }
          }
        }
        // Parse otaUrl if present (Cloud OTA Update Trigger)
        int otaIdx = payload.indexOf("\"otaUrl\":\"");
        if (otaIdx != -1) {
          int endOta = payload.indexOf("\"", otaIdx + 10);
          if (endOta != -1) {
            String otaUrl = payload.substring(otaIdx + 10, endOta);
            if (otaUrl.length() > 10) {
              Serial.println("OTA Command received from Cloud! Downloading: " + otaUrl);
              // Clear otaUrl in Firebase so it doesn't loop
              http.end();
              http.begin(client, "https://my-smart-off-grid-default-rtdb.firebaseio.com/commands.json");
              http.addHeader("Content-Type", "application/json");
              http.PATCH("{\"otaUrl\":\"\"}");
              http.end();

              // Perform OTA Update
              t_httpUpdate_return ret = httpUpdate.update(client, otaUrl);
              if (ret == HTTP_UPDATE_OK) {
                Serial.println("OTA Update Successful! Restarting ESP32...");
                ESP.restart();
              }
            }
          }
        }
      }
      http.end();

      // Evaluate if App session is active (App opened within 3 hours or pinged)
      if (lastAppHeartbeatTime == 0) lastAppHeartbeatTime = millis(); // Boot default
      if ((millis() - lastAppHeartbeatTime) < ACTIVE_SESSION_TIMEOUT_MS) {
        isAppSessionActive = true;
      } else {
        isAppSessionActive = false;
      }

      // 2. Push status telemetry to Firebase ONLY when App session is active
      if (isAppSessionActive) {
        String firebaseUrl = "https://my-smart-off-grid-default-rtdb.firebaseio.com/status.json";
        http.begin(client, firebaseUrl); // Use WiFiClientSecure
        http.addHeader("Content-Type", "application/json");

        String jsonPayload = "{";
        jsonPayload += "\"batteryVoltage\":" + String(lastBatVolt, 2) + ",";
        jsonPayload += "\"batteryCurrent\":" + String(jkbms.current, 2) + ",";
        jsonPayload += "\"batterySoc\":" + String(jkbms.soc) + ",";
        jsonPayload += "\"cellVoltages\":[" + String(jkbms.cellVoltages[0], 3) + "," + String(jkbms.cellVoltages[1], 3) + "," + String(jkbms.cellVoltages[2], 3) + "," + String(jkbms.cellVoltages[3], 3) + "],";
        jsonPayload += "\"solarVoltage\":" + String(lastSolVolt, 2) + ",";
        jsonPayload += "\"gridPresent\":" + String(debouncedGridState ? "true" : "false") + ",";
        jsonPayload += "\"inverterState\":" + String(inverterState ? "true" : "false") + ",";
        jsonPayload += "\"smpsState\":" + String(smpsState ? "true" : "false") + ",";
        jsonPayload += "\"modeString\":\"" + currentModeString + "\",";
        jsonPayload += "\"webModeOverride\":" + String(webModeOverride) + ",";
        jsonPayload += "\"forceChargingActive\":" + String(forceChargingActive ? "true" : "false") + ",";
        jsonPayload += "\"topup530Active\":" + String(topup530Active ? "true" : "false") + ",";
        jsonPayload += "\"topup1amActive\":" + String(topup1amActive ? "true" : "false") + ",";
        jsonPayload += "\"normalChargingActive\":" + String(normalChargingActive ? "true" : "false") + ",";
        jsonPayload += "\"flatlineDetected\":" + String(flatlineDetected ? "true" : "false") + ",";
        jsonPayload += "\"wifiConnected\":true,";
        jsonPayload += "\"rssi\":" + String(WiFi.RSSI()) + ",";
        jsonPayload += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
        jsonPayload += "\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) + "\",";
        jsonPayload += "\"sessionActive\":true";
        jsonPayload += "}";

        http.PUT(jsonPayload);
        http.end();
      }

      // 3. Periodic 15-Minute History Logging to Firebase Database
      if (lastHistoryLogTime == 0 || (millis() - lastHistoryLogTime >= HISTORY_LOG_INTERVAL)) {
        lastHistoryLogTime = millis();
        String historyUrl = "https://my-smart-off-grid-default-rtdb.firebaseio.com/history.json";
        http.begin(client, historyUrl);
        http.addHeader("Content-Type", "application/json");

        String histPayload = "{";
        histPayload += "\"epoch\":" + String(timeClient.getEpochTime()) + ",";
        histPayload += "\"time\":\"" + timeClient.getFormattedTime() + "\",";
        histPayload += "\"batteryVoltage\":" + String(lastBatVolt, 2) + ",";
        histPayload += "\"batteryCurrent\":" + String(jkbms.current, 2) + ",";
        histPayload += "\"batterySoc\":" + String(jkbms.soc) + ",";
        histPayload += "\"cellVoltages\":[" + String(jkbms.cellVoltages[0], 3) + "," + String(jkbms.cellVoltages[1], 3) + "," + String(jkbms.cellVoltages[2], 3) + "," + String(jkbms.cellVoltages[3], 3) + "],";
        histPayload += "\"solarVoltage\":" + String(lastSolVolt, 2) + ",";
        histPayload += "\"gridPresent\":" + String(debouncedGridState ? "true" : "false") + ",";
        histPayload += "\"inverterState\":" + String(inverterState ? "true" : "false") + ",";
        histPayload += "\"smpsState\":" + String(smpsState ? "true" : "false") + ",";
        histPayload += "\"mode\":\"" + currentModeString + "\"";
        histPayload += "}";

        http.POST(histPayload);
        http.end();
      }
    }
    
    // Wait 2.5 seconds before the next Firebase sync
    // vTaskDelay frees up Core 0 to handle WiFi duties without blocking
    vTaskDelay(2500 / portTICK_PERIOD_MS);
  }
}

void loop() {
  // Handle local web server requests
  server.handleClient();

  // Read incoming BMS data constantly
  jkbms.readData(Serial2);

  // Request new data from BMS every 2 seconds
  if (millis() - lastBmsRequest >= 2000) {
    jkbms.requestData(Serial2);
    lastBmsRequest = millis();
  }


  String displayTime = "--:--";
  int currentHour = 12; 
  int currentMinute = 0; 

  if (WiFi.status() == WL_CONNECTED) {
    timeClient.update();
    displayTime = timeClient.getFormattedTime().substring(0, 5);
    currentHour = timeClient.getHours(); 
    currentMinute = timeClient.getMinutes(); 
    static unsigned long lastRtcSync = 0;
    if (millis() - lastRtcSync >= 3600000 || lastRtcSync == 0) {
      unsigned long epoch = timeClient.getEpochTime();
      if (epoch > 1767225600) { 
        rtc.adjust(DateTime(epoch)); 
        lastRtcSync = millis();
      }
    }
  } else {
    DateTime now = rtc.now();
    char buf[] = "hh:mm";
    displayTime = String(now.toString(buf));
    currentHour = now.hour(); 
    currentMinute = now.minute(); 
  }

  float batVolt = getBatteryVoltage();
  float solVolt = getSolarVoltage(); 
  
  // Software debounce for Grid Sensing to prevent noise triggers
  bool gridRaw = digitalRead(GRID_SENS);
  if (gridRaw != lastGridRawState) {
    lastGridDebounceTime = millis();
    lastGridRawState = gridRaw;
  }
  if ((millis() - lastGridDebounceTime) >= GRID_DEBOUNCE_DELAY_MS) {
    debouncedGridState = gridRaw;
  }
  bool isGrid = debouncedGridState;
  
  // Physical Switches Reading
  bool rawManual = (digitalRead(MANUAL_SWITCH) == LOW); 
  bool rawEco   = rawManual ? false : (digitalRead(ECO_SWITCH) == LOW);
  bool rawPcut  = rawManual ? false : (digitalRead(PCUT_SWITCH) == LOW);

  // Evaluate Active Mode (Physical Switches or Web Override)
  bool manualMode = rawManual;
  bool ecoMode    = rawEco;
  bool pcutMode   = rawPcut;

  if (webModeOverride == 0) { // POWER OFF
    manualMode = false; ecoMode = false; pcutMode = false;
  } else if (webModeOverride == 1) { // ECO MODE
    manualMode = false; ecoMode = true; pcutMode = false;
  } else if (webModeOverride == 2) { // POWER CUT
    manualMode = false; ecoMode = false; pcutMode = true;
  } else if (webModeOverride == 3) { // ECO+POWER CUT
    manualMode = false; ecoMode = true; pcutMode = true;
  } else if (webModeOverride == 4) { // MANUAL OVERRIDE
    manualMode = true; ecoMode = false; pcutMode = false;
  }
  
  String modeString = "POWER OFF"; 
  String errorString = ""; 

  if (batVolt < 5.0 || !jkbms.dataValid) {
    errorString = "BAT WIRE FAULT"; 
  }

  if (millis() - statusToggleTime >= 3000) {
    statusPage = (statusPage + 1) % 3;
    statusToggleTime = millis();
  }

  // ---------------------------------------------------------
  // ⏳ SMART TIMER LOGIC
  // ---------------------------------------------------------
  bool shouldRunGridReturnTimer = false;
  if (isGrid && inverterState) {
    if (pcutMode || ecoMode) {
      shouldRunGridReturnTimer = true; 
    }
  }

  if (shouldRunGridReturnTimer) {
    if (!gridReturnTimerActive) {
      gridReturnTime = millis();
      gridReturnTimerActive = true;
    }
  } else {
    gridReturnTimerActive = false;
    gridReturnTime = 0;
  }

  // Power-cut timer: runs in PCUT and ECO+PCUT mode, but only when inverter is OFF
  if (!isGrid && !inverterState && pcutMode) {
    if (!powerCutTimerActive) {
      powerCutTime = millis();
      powerCutTimerActive = true;
    }
  } else {
    powerCutTimerActive = false;
    powerCutTime = 0; 
  }

  int countdownSecs = -1;
  String countdownType = "";

  if (gridReturnTimerActive) {
    long elapsed = (millis() - gridReturnTime) / 1000;
    if (elapsed < TIMER_DELAY_SEC) {
      countdownSecs = TIMER_DELAY_SEC - elapsed;
      countdownType = "GRID_RET";
    }
  }
  else if (powerCutTimerActive) {
    long elapsed = (millis() - powerCutTime) / 1000;
    if (elapsed < TIMER_DELAY_SEC) {
      countdownSecs = TIMER_DELAY_SEC - elapsed;
      countdownType = "PWR_CUT";
    }
  }

  // ---------------------------------------------------------
  // CORE AUTOMATION LOGIC 
  // ---------------------------------------------------------
  if (errorString != "") {
    modeString = "ERROR";
    inverterState = false;
    smpsState = false;
  }
  else if (manualMode) {
    modeString = "MANUAL";
    inverterState = manualInverterOverride;
    smpsState = manualSmpsOverride;
  }
  else if (ecoMode && pcutMode) {
    modeString = "ECO+POWER CUT"; 
    
    if (!isGrid) {
      if (inverterState) {
        if (batVolt <= 12.0) inverterState = false;
      } else {
        if (powerCutTimerActive && (millis() - powerCutTime >= TIMER_DELAY_MS) && batVolt >= 12.5) {
          inverterState = true;
        }
        if (batVolt <= 12.0) inverterState = false;
      }
    } else {
      if (gridReturnTimerActive && (millis() - gridReturnTime >= TIMER_DELAY_MS)) {
        inverterState = false;
      }
    }
  } 
  else if (ecoMode) {
    modeString = "ECO MODE";
    inverterState = false;
  } 
  else if (pcutMode) {
    modeString = "POWER CUT"; 
    if (!isGrid) {
      if (powerCutTimerActive && (millis() - powerCutTime >= TIMER_DELAY_MS) && batVolt >= 12.5) {
        inverterState = true;
      }
      if (batVolt <= 12.0) inverterState = false; 
    } else {
      if (gridReturnTimerActive && (millis() - gridReturnTime >= TIMER_DELAY_MS)) {
        inverterState = false; 
      }
    }
  } 
  else {
    modeString = "POWER OFF";
    inverterState = false;
  }

  // ---------------------------------------------------------
  // ⚡ SMPS EXTRA CHARGER LOGIC (WITH PREVENT LOOPING & GRID DEBOUNCE)
  // ---------------------------------------------------------
  bool allowCharging = (errorString == "") /* && isGrid */ && !inverterState && !manualMode && (ecoMode || pcutMode || modeString == "POWER OFF");

  // Reset top-up Done flags when we are outside the respective time windows
  if (currentHour != 17) {
    topup530Done = false;
  }
  if (currentHour != 1) {
    topup1amDone = false;
  }

  // Auto safety cutoff for force charging if battery reaches stop threshold
  if (forceChargingActive && batVolt >= BAT_CHARGE_STOP_THRESHOLD) {
    forceChargingActive = false;
  }

  if (forceChargingActive) {
    smpsState = true;
  }
  else if (allowCharging) {
    
    // 1. Mandatory 5:30 PM top-up charge (Evening Prep Logic)
    if ((currentHour == 17 && currentMinute >= 30) && batVolt < BAT_TOPUP_START_THRESHOLD && !topup530Done && !topup1amActive && !normalChargingActive) {
      topup530Active = true;
    }
    
    // 2. Mandatory 1:00 AM battery top-up charge (Night Emergency Backup)
    if (currentHour == 1 && batVolt < BAT_TOPUP_START_THRESHOLD && !topup1amDone && !topup530Active && !normalChargingActive) {
      topup1amActive = true;
    }
    
    // 3. Charge when battery level drops below normal threshold (Anytime)
    if (batVolt <= BAT_CHARGE_START_THRESHOLD && !topup530Active && !topup1amActive) {
      normalChargingActive = true;
    }


    // --- Flatline Detection Logic ---
    if (topup530Active || topup1amActive || normalChargingActive) {
      if (batVolt >= DVDT_START_VOLTAGE) {
        if (lastRecordedVoltage == 0.0) {
          lastRecordedVoltage = batVolt;
          lastVoltageCheckTime = millis();
          flatlineDetected = false;
        } else {
          if (millis() - lastVoltageCheckTime >= VOLTAGE_CHECK_INTERVAL) {
            if (batVolt <= lastRecordedVoltage) {
              flatlineDetected = true; 
            }
            lastRecordedVoltage = batVolt;
            lastVoltageCheckTime = millis();
          }
        }
      } else {
        lastRecordedVoltage = 0.0;
        flatlineDetected = false;
      }
    } else {
      lastRecordedVoltage = 0.0;
      flatlineDetected = false;
    }
    // --- SMPS STATE EVALUATION & OFF CONDITIONS ---
    if (topup530Active) {
      smpsState = true;
      if (batVolt >= BAT_CHARGE_STOP_THRESHOLD || flatlineDetected) {
        topup530Active = false;
        topup530Done = true; 
        smpsState = false;
      }
    }
    else if (topup1amActive) {
      smpsState = true;
      if (batVolt >= BAT_CHARGE_STOP_THRESHOLD || flatlineDetected) {
        topup1amActive = false;
        topup1amDone = true; 
        smpsState = false;
      }
    }
    else if (normalChargingActive) {
      smpsState = true;
      if (batVolt >= BAT_CHARGE_STOP_THRESHOLD || flatlineDetected) {
        normalChargingActive = false;
        smpsState = false;
      }
    }
    else {
      smpsState = false;
    }
    
  } else {
    // Reset all charging states if charging is not allowed
    topup530Active = false;
    topup1amActive = false;
    normalChargingActive = false;
    smpsState = false; 
  }

  // Execute Relay Actions
  digitalWrite(INV_RELAY, inverterState ? LOW : HIGH);
  digitalWrite(SMPS_RELAY, smpsState ? LOW : HIGH);

  // Override display modeString if charging
  if (smpsState) {
    if (forceChargingActive) {
      modeString = "FORCE CHG";
    } else if (topup530Active) {
      modeString = "5:30 TOPUP";
    } else if (topup1amActive) {
      modeString = "1AM TOPUP";
    } else if (normalChargingActive) {
      modeString = "SMPS CHG";
    }
  }

  currentModeString = modeString;

  // ---------------------------------------------------------
  // OLED DISPLAY GRAPHICS LAYOUT
  // ---------------------------------------------------------
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  drawWiFiBars(2, 1);

  display.setCursor(48, 1);
  if (errorString == "BAT WIRE FAULT") {
    display.print(F("--.-V"));
  } else {
    display.print(batVolt, 1);
    display.print(F("V"));
  }

  display.setCursor(95, 1);
  display.print(displayTime);
  
  display.drawFastHLine(0, 11, 128, SSD1306_WHITE);

  display.setCursor(0, 20);
  if (countdownSecs >= 0) {
    display.setTextSize(2); 
    display.print(countdownSecs);
    display.print(F("s WAIT"));
  } 
  else {
    if (modeString == "ECO+POWER CUT") {
      display.setTextSize(1); 
      display.setCursor(0, 24);
    } else {
      display.setTextSize(2);
    }
    display.print(modeString);
  }

  display.drawFastHLine(0, 42, 128, SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(0, 50);
  
  if (modeString == "ERROR") {
    display.print(F("Fault: "));
    display.print(errorString);
  } 
  else if (countdownSecs >= 0) {
    if (countdownType == "PWR_CUT") {
      display.print(F("Grid DOWN -> INV ON"));
    } else if (countdownType == "GRID_RET") {
      display.print(F("Grid OK -> INV OFF"));
    }
  }
  else {
    if (statusPage == 0) {
      display.print(F("Relay: "));
      if (inverterState) display.print(F("INVERTER ON"));
      else if (smpsState) display.print(F("SMPS CHARGING"));
      else display.print(F("ALL RELAYS OFF"));
    } 
    else if (statusPage == 1) {
      display.print(F("Grid:"));
      display.print(isGrid ? F("OK") : F("DOWN"));
      display.print(F(" | Sun:"));
      if (solVolt > 5.0) {
        display.print(solVolt, 1);
        display.print("V");
      } else {
        display.print("NO");
      }
    } 
    else if (statusPage == 2) {
      display.print(F("Status: "));
      if (modeString == "POWER OFF") display.print(F("SYSTEM SHUTDOWN"));
      else if (modeString == "MANUAL") display.print(F("MANUAL OVERRIDE"));
      else if (!isGrid && batVolt <= 12.0) display.print(F("BATTERY CUTOFF"));
      else display.print(F("SYSTEM NORMAL"));
    }
  }

  display.display();
  delay(200); 
}