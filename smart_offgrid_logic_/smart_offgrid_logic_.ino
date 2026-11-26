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
#include <PubSubClient.h>
#include "JK_BMS.h"
#include "aws_certs.h"

JKBMS jkbms;
unsigned long lastBmsRequest = 0;

// OLED Display Settings
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
bool oledFound = false;

// RTC Setting
RTC_DS3231 rtc;
bool rtcFound = false;

// WiFi Credentials
const char* ssid = "SLT FIBER";
const char* password = "@Ashan20030118";

// Firmware Versioning
const char* FIRMWARE_VERSION = "v1.0.5";

// ---------------------------------------------------------
// MQTT Broker Configuration (Lightweight Cloud Sync)
// ---------------------------------------------------------
const char* mqtt_server       = "broker.emqx.io";
const int   mqtt_port         = 1883;
const char* mqtt_user         = ""; // Optional: set if using private HiveMQ/EMQX cluster
const char* mqtt_pass         = "";
const char* TOPIC_STATUS      = "ashan_smart_offgrid_v1/status";
const char* TOPIC_COMMANDS    = "ashan_smart_offgrid_v1/commands";
const char* TOPIC_HISTORY     = "ashan_smart_offgrid_v1/history";
const char* TOPIC_AVAILABILITY = "ashan_smart_offgrid_v1/availability";

WiFiClientSecure mqttSecureClient;
WiFiClient mqttWifiClient;
PubSubClient mqttClient;
bool useAwsMtls = false;

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
const unsigned long TIMER_DELAY_MS = 120000; 
const int TIMER_DELAY_SEC = 120;

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

// Dual-Core Thread-Safe Shared State (Core 0 MQTT/Network <-> Core 1 Control/OLED/I2C)
portMUX_TYPE stateMux = portMUX_INITIALIZER_UNLOCKED;
char currentModeBuf[20] = "POWER OFF";
volatile unsigned long cachedEpoch = 0;

void setCurrentModeSafe(const char* mode) {
  portENTER_CRITICAL(&stateMux);
  strncpy(currentModeBuf, mode, sizeof(currentModeBuf) - 1);
  currentModeBuf[sizeof(currentModeBuf) - 1] = '\0';
  portEXIT_CRITICAL(&stateMux);
}

void getCurrentModeSafe(char* out, size_t maxLen) {
  if (maxLen == 0) return;
  portENTER_CRITICAL(&stateMux);
  strncpy(out, currentModeBuf, maxLen - 1);
  out[maxLen - 1] = '\0';
  portEXIT_CRITICAL(&stateMux);
}

// Web Control & Override Variables
// webModeOverride: -1 = Auto (Physical Switches), 0 = POWER OFF, 1 = ECO MODE, 2 = POWER CUT, 3 = ECO+POWER CUT, 4 = MANUAL
int webModeOverride = -1;
bool forceChargingActive = false;
bool manualInverterOverride = false;
bool manualSmpsOverride = false;

// --- Physical Switch Change Tracking (For Offline & Emergency Switch Priority) ---
bool prevRawManual = false;
bool prevRawEco = false;
bool prevRawPcut = false;
bool switchTrackerInitialized = false;

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

// Function declarations for API & Tasks
void handleGetStatus();
void handleSetMode();
void handleSetCharge();
void handleSetRelay();
void handleOTAUpdate();
void syncFirebaseTask(void * pvParameters);
void mqttCallback(char* topic, byte* payload, unsigned int length);

unsigned long lastAppHeartbeatTime = 0;
char lastReceivedHeartbeatBuf[32] = ""; // Tracks if heartbeat timestamp changed on Core 0
const unsigned long ACTIVE_SESSION_TIMEOUT_MS = 90000UL; // 90s active live-stream window (renewed at ~65s right before sleep)
bool isAppSessionActive = true;
TaskHandle_t FirebaseTaskHandle;

volatile bool forceImmediatePublish = false;
char pendingOtaUrlBuf[256] = "";
volatile bool hasPendingOta = false;

void setPendingOtaUrlSafe(const char* url) {
  if (!url) return;
  portENTER_CRITICAL(&stateMux);
  strncpy(pendingOtaUrlBuf, url, sizeof(pendingOtaUrlBuf) - 1);
  pendingOtaUrlBuf[sizeof(pendingOtaUrlBuf) - 1] = '\0';
  hasPendingOta = (strlen(pendingOtaUrlBuf) > 10);
  portEXIT_CRITICAL(&stateMux);
}

bool takePendingOtaUrlSafe(char* out, size_t maxLen) {
  bool found = false;
  portENTER_CRITICAL(&stateMux);
  if (hasPendingOta && maxLen > 0) {
    strncpy(out, pendingOtaUrlBuf, maxLen - 1);
    out[maxLen - 1] = '\0';
    pendingOtaUrlBuf[0] = '\0';
    hasPendingOta = false;
    found = true;
  }
  portEXIT_CRITICAL(&stateMux);
  return found;
}

// --- 15-Minute Periodic History Logging & Offline Ring Buffer ---
unsigned long lastHistoryLogTime = 0;
const unsigned long HISTORY_LOG_INTERVAL = 900000; // 15 minutes (900,000 ms)

struct OfflineHistoryRecord {
  unsigned long epoch;
  float batteryVoltage;
  float batteryCurrent;
  int batterySoc;
  float cellVoltages[4];
  float solarVoltage;
  bool gridPresent;
  bool inverterState;
  bool smpsState;
  char mode[18];
};

const int MAX_OFFLINE_HISTORY = 32; // Stores up to 8 hours of 15-min logs in RAM while offline
OfflineHistoryRecord offlineHistoryBuffer[MAX_OFFLINE_HISTORY];
int offlineHistoryHead = 0;
int offlineHistoryCount = 0;

// Thread-safe Unix Epoch getter (Core 1 updates cachedEpoch from NTP/RTC; Core 0 reads without I2C/UDP collision)
unsigned long getCurrentEpoch() {
  unsigned long ep = cachedEpoch;
  if (ep > 1700000000UL) return ep;
  return millis() / 1000;
}

// Helper to enqueue a 15-minute history record when offline
void enqueueOfflineHistory() {
  int insertIdx = (offlineHistoryHead + offlineHistoryCount) % MAX_OFFLINE_HISTORY;
  if (offlineHistoryCount == MAX_OFFLINE_HISTORY) {
    // Buffer full: overwrite oldest entry
    offlineHistoryHead = (offlineHistoryHead + 1) % MAX_OFFLINE_HISTORY;
  } else {
    offlineHistoryCount++;
  }

  OfflineHistoryRecord &rec = offlineHistoryBuffer[insertIdx];
  rec.epoch = getCurrentEpoch();
  rec.batteryVoltage = lastBatVolt;
  rec.batteryCurrent = jkbms.current;
  rec.batterySoc = jkbms.soc;
  for (int i = 0; i < 4; i++) rec.cellVoltages[i] = jkbms.cellVoltages[i];
  rec.solarVoltage = lastSolVolt;
  rec.gridPresent = debouncedGridState;
  rec.inverterState = inverterState;
  rec.smpsState = smpsState;
  getCurrentModeSafe(rec.mode, sizeof(rec.mode));
}

// Helper to build status JSON payload
String buildStatusJson() {
  char modeSnap[20];
  getCurrentModeSafe(modeSnap, sizeof(modeSnap));

  String json = "{";
  json += "\"epoch\":" + String(getCurrentEpoch()) + ",";
  json += "\"batteryVoltage\":" + String(lastBatVolt, 2) + ",";
  json += "\"batteryCurrent\":" + String(jkbms.current, 2) + ",";
  json += "\"batterySoc\":" + String(jkbms.soc) + ",";
  json += "\"cellVoltages\":[" + String(jkbms.cellVoltages[0], 3) + "," + String(jkbms.cellVoltages[1], 3) + "," + String(jkbms.cellVoltages[2], 3) + "," + String(jkbms.cellVoltages[3], 3) + "],";
  json += "\"solarVoltage\":" + String(lastSolVolt, 2) + ",";
  json += "\"gridPresent\":" + String(debouncedGridState ? "true" : "false") + ",";
  json += "\"inverterState\":" + String(inverterState ? "true" : "false") + ",";
  json += "\"smpsState\":" + String(smpsState ? "true" : "false") + ",";
  json += "\"modeString\":\"" + String(modeSnap) + "\",";
  json += "\"webModeOverride\":" + String(webModeOverride) + ",";
  json += "\"forceChargingActive\":" + String(forceChargingActive ? "true" : "false") + ",";
  json += "\"topup530Active\":" + String(topup530Active ? "true" : "false") + ",";
  json += "\"topup1amActive\":" + String(topup1amActive ? "true" : "false") + ",";
  json += "\"normalChargingActive\":" + String(normalChargingActive ? "true" : "false") + ",";
  json += "\"flatlineDetected\":" + String(flatlineDetected ? "true" : "false") + ",";
  json += "\"wifiConnected\":" + String(WiFi.status() == WL_CONNECTED ? "true" : "false") + ",";
  json += "\"mqttConnected\":" + String(mqttClient.connected() ? "true" : "false") + ",";
  json += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  json += "\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) + "\",";
  json += "\"sessionActive\":" + String(isAppSessionActive ? "true" : "false");
  json += "}";
  return json;
}

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

  // Sensing and Switch Pins (INPUT_PULLDOWN prevents floating HIGH when optocoupler turns off)
  pinMode(GRID_SENS, INPUT_PULLDOWN);
  pinMode(ECO_SWITCH, INPUT_PULLUP);
  pinMode(PCUT_SWITCH, INPUT_PULLUP);
  pinMode(MANUAL_SWITCH, INPUT_PULLUP);

  // Initialize OLED (Non-blocking: system continues autonomously even if OLED wire is loose)
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println(F("SSD1306 allocation failed - continuing without OLED"));
    oledFound = false;
  } else {
    oledFound = true;
    display.clearDisplay();
    display.display();
  }

  // Initialize RTC
  if (!rtc.begin()) {
    Serial.println("RTC Not Found!");
    rtcFound = false;
  } else {
    rtcFound = true;
    DateTime now = rtc.now();
    if (now.unixtime() > 1700000000UL) {
      cachedEpoch = now.unixtime();
    }
  }

  // Initialize debounced grid state to avoid 1-second false power-cut at boot
  lastGridRawState = digitalRead(GRID_SENS);
  debouncedGridState = lastGridRawState;

  // Connect to WiFi (Non-blocking auto-reconnect enabled)
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid, password);
  timeClient.begin();

  // Configure MQTT Client (AWS IoT Core mTLS with Certificates if AWS_IOT_ENDPOINT is set, otherwise standard TCP)
  if (String(AWS_IOT_ENDPOINT).indexOf("YOUR_AWS_IOT_ENDPOINT") == -1 && strlen(AWS_IOT_ENDPOINT) > 10) {
    useAwsMtls = true;
    mqttSecureClient.setCACert(AWS_CERT_CA);
    mqttSecureClient.setCertificate(AWS_CERT_CRT);
    mqttSecureClient.setPrivateKey(AWS_CERT_PRIVATE);
    mqttClient.setClient(mqttSecureClient);
    mqttClient.setServer(AWS_IOT_ENDPOINT, AWS_IOT_PORT);
    Serial.println("MQTT Configured with AWS IoT Core mTLS Certificates (Port 8883)");
  } else {
    useAwsMtls = false;
    mqttClient.setClient(mqttWifiClient);
    mqttClient.setServer(mqtt_server, mqtt_port);
    Serial.println("MQTT Configured for Standard TCP Broker");
  }
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(1024); // Ensure 1KB buffer for full JSON telemetry
  mqttClient.setKeepAlive(60);    // 60s MQTT keep-alive (4x lower ping rate for free-tier limits)
  mqttClient.setSocketTimeout(3);

  // Configure Local Web Server & CORS (Works on Local Wi-Fi even if Internet is down)
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

  // Start Lightweight MQTT & Offline Sync Task on Core 0 (Network Core)
  // Core 1 runs OLED, JK BMS, Relays & Switches with zero network lag
  xTaskCreatePinnedToCore(
    syncFirebaseTask,   // Task function
    "NetworkSyncTask",  // Name of task
    8192,               // Stack size
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
  // Check 10s BMS timeout so a disconnected BMS UART wire triggers BAT WIRE FAULT
  jkbms.checkTimeout();
  if (jkbms.dataValid) {
    lastBatVolt = jkbms.voltage;
  } else {
    lastBatVolt = 0.0;
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
// 🌐 LOCAL WEB SERVER API HANDLERS (LAN FALLBACK)
// ---------------------------------------------------------
void handleGetStatus() {
  server.send(200, "application/json", buildStatusJson());
}

void handleSetMode() {
  if (server.hasArg("mode")) {
    webModeOverride = server.arg("mode").toInt();
    forceImmediatePublish = true;
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
  forceImmediatePublish = true;
  server.send(200, "application/json", "{\"success\":true,\"forceChargingActive\":" + String(forceChargingActive ? "true" : "false") + "}");
}

void handleSetRelay() {
  if (server.hasArg("inverter")) {
    manualInverterOverride = (server.arg("inverter") == "true" || server.arg("inverter") == "1");
  }
  if (server.hasArg("smps")) {
    manualSmpsOverride = (server.arg("smps") == "true" || server.arg("smps") == "1");
  }
  forceImmediatePublish = true;
  server.send(200, "application/json", "{\"success\":true}");
}

void handleOTAUpdate() {
  if (!server.hasArg("url")) {
    server.send(400, "application/json", "{\"error\":\"Missing firmware URL parameter\"}");
    return;
  }
  String firmwareUrl = server.arg("url");
  server.send(200, "application/json", "{\"success\":true,\"message\":\"Starting OTA update from GitHub...\"}");
  setPendingOtaUrlSafe(firmwareUrl.c_str());
}

// ---------------------------------------------------------
// ⚡ INSTANT MQTT COMMAND CALLBACK (0ms Polling Overhead)
// ---------------------------------------------------------
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String msg = "";
  msg.reserve(length + 1);
  for (unsigned int i = 0; i < length; i++) {
    msg += (char)payload[i];
  }

  bool stateChanged = false;

  // 1. Parse webModeOverride if present
  int modeIdx = msg.indexOf("\"webModeOverride\":");
  if (modeIdx != -1) {
    int val = msg.substring(modeIdx + 18).toInt();
    if (val >= -1 && val <= 4) {
      webModeOverride = val;
      stateChanged = true;
    }
  }

  // 2. Parse forceChargingActive if present
  int chargeIdx = msg.indexOf("\"forceChargingActive\":");
  if (chargeIdx != -1) {
    String valStr = msg.substring(chargeIdx + 22, min((int)msg.length(), chargeIdx + 28));
    forceChargingActive = (valStr.indexOf("true") != -1 || valStr.indexOf("1") != -1);
    stateChanged = true;
  }

  // 3. Parse manual relay overrides if present
  int invIdx = msg.indexOf("\"inverter\":");
  if (invIdx != -1) {
    String valStr = msg.substring(invIdx + 11, min((int)msg.length(), invIdx + 17));
    manualInverterOverride = (valStr.indexOf("true") != -1 || valStr.indexOf("1") != -1);
    stateChanged = true;
  }

  int smpsIdx = msg.indexOf("\"smps\":");
  if (smpsIdx != -1) {
    String valStr = msg.substring(smpsIdx + 7, min((int)msg.length(), smpsIdx + 13));
    manualSmpsOverride = (valStr.indexOf("true") != -1 || valStr.indexOf("1") != -1);
    stateChanged = true;
  }

  // 4. Parse lastHeartbeat / app active ping
  int hbIdx = msg.indexOf("\"lastHeartbeat\":");
  if (hbIdx != -1) {
    int commaIdx = msg.indexOf(",", hbIdx);
    if (commaIdx == -1) commaIdx = msg.indexOf("}", hbIdx);
    if (commaIdx != -1) {
      String hbValue = msg.substring(hbIdx + 16, commaIdx);
      if (hbValue != String(lastReceivedHeartbeatBuf)) {
        strncpy(lastReceivedHeartbeatBuf, hbValue.c_str(), sizeof(lastReceivedHeartbeatBuf) - 1);
        lastReceivedHeartbeatBuf[sizeof(lastReceivedHeartbeatBuf) - 1] = '\0';
        lastAppHeartbeatTime = millis();
        isAppSessionActive = true;
      }
    }
  }

  // 5. Parse otaUrl if present (Cloud OTA Update Trigger)
  int otaIdx = msg.indexOf("\"otaUrl\":\"");
  if (otaIdx != -1) {
    int endOta = msg.indexOf("\"", otaIdx + 10);
    if (endOta != -1) {
      String otaUrl = msg.substring(otaIdx + 10, endOta);
      if (otaUrl.length() > 10) {
        setPendingOtaUrlSafe(otaUrl.c_str());
      }
    }
  }

  if (stateChanged) {
    forceImmediatePublish = true;
  }
}

// ---------------------------------------------------------
// 🌐 LIGHTWEIGHT MQTT & OFFLINE-RESILIENT TASK (CORE 0)
// ---------------------------------------------------------
void syncFirebaseTask(void * pvParameters) {
  unsigned long lastWifiCheck = 0;
  unsigned long lastMqttReconnectAttempt = 0;
  unsigned long lastStatusPublish = 0;

  for (;;) {
    unsigned long now = millis();

    // 1. Periodic 15-Minute History Snapshot Recording (Works Online AND Offline once BMS data is valid!)
    if (jkbms.dataValid && lastBatVolt > 5.0 && (lastHistoryLogTime == 0 || (now - lastHistoryLogTime >= HISTORY_LOG_INTERVAL))) {
      lastHistoryLogTime = now;
      enqueueOfflineHistory();
    }

    // 2. Non-Blocking Wi-Fi Connection Supervision
    if (WiFi.status() != WL_CONNECTED) {
      if (now - lastWifiCheck >= 5000) {
        lastWifiCheck = now;
        WiFi.reconnect();
      }
      vTaskDelay(200 / portTICK_PERIOD_MS);
      continue;
    }

    // 3. Handle Pending OTA Firmware Update (Only when triggered)
    char otaUrlBuf[256];
    if (takePendingOtaUrlSafe(otaUrlBuf, sizeof(otaUrlBuf))) {
      String urlToFlash = String(otaUrlBuf);
      Serial.println("Starting OTA Update from: " + urlToFlash);

      WiFiClientSecure otaClient;
      otaClient.setInsecure();
      t_httpUpdate_return ret = httpUpdate.update(otaClient, urlToFlash);
      if (ret == HTTP_UPDATE_OK) {
        Serial.println("OTA Update Successful! Restarting ESP32...");
        ESP.restart();
      } else {
        Serial.printf("OTA Update Failed (%d): %s\n", httpUpdate.getLastError(), httpUpdate.getLastErrorString().c_str());
      }
    }

    // 4. Non-Blocking MQTT Reconnection with Last Will & Testament (LWT)
    if (!mqttClient.connected()) {
      if (now - lastMqttReconnectAttempt >= 5000) {
        lastMqttReconnectAttempt = now;
        String clientId = "ESP32_SmartOffGrid_" + String((uint32_t)ESP.getEfuseMac(), HEX);

        bool connected = false;
        if (strlen(mqtt_user) > 0) {
          connected = mqttClient.connect(
            clientId.c_str(),
            mqtt_user,
            mqtt_pass,
            TOPIC_AVAILABILITY,
            0,
            false,
            "offline"
          );
        } else {
          connected = mqttClient.connect(
            clientId.c_str(),
            TOPIC_AVAILABILITY,
            0,
            false,
            "offline"
          );
        }

        if (connected) {
          Serial.println("MQTT Connected! Publishing online availability & subscribing...");
          mqttClient.publish(TOPIC_AVAILABILITY, "online", false);
          mqttClient.subscribe(TOPIC_COMMANDS, 1);
          forceImmediatePublish = true;
        }
      }
    } else {
      // Process incoming MQTT packets instantly
      mqttClient.loop();

      // 5. Evaluate 90-Second Active Dashboard Session Timeout (renewed at ~65s right before sleep)
      if (lastAppHeartbeatTime == 0) lastAppHeartbeatTime = now;
      isAppSessionActive = ((now - lastAppHeartbeatTime) < ACTIVE_SESSION_TIMEOUT_MS);

      // 6. Rate-Limit-Friendly Adaptive MQTT Telemetry:
      //    - Active dashboard open: 2s live updates
      //    - Background / Discharging (Inverter ON or load current > 0.05A): every 2 min (120,000 ms)
      //    - Background / Charging (SMPS ON or charge current < -0.05A): every 5 min (300,000 ms)
      //    - Background / Idle Standby: every 15 min (900,000 ms)
      unsigned long publishIntervalMs = 900000UL;
      if (isAppSessionActive) {
        publishIntervalMs = 2000UL;
      } else if (inverterState || jkbms.current > 0.05f) {
        publishIntervalMs = 120000UL;
      } else if (smpsState || jkbms.current < -0.05f) {
        publishIntervalMs = 300000UL;
      }

      if (forceImmediatePublish || (now - lastStatusPublish >= publishIntervalMs)) {
        forceImmediatePublish = false;
        lastStatusPublish = now;
        String statusPayload = buildStatusJson();
        mqttClient.publish(TOPIC_STATUS, statusPayload.c_str(), false);
      }

      // 7. Flush Any Offline-Buffered 15-Minute History Logs to Backend -> MongoDB
      if (offlineHistoryCount > 0) {
        OfflineHistoryRecord &rec = offlineHistoryBuffer[offlineHistoryHead];

        String histJson = "{";
        histJson += "\"epoch\":" + String(rec.epoch) + ",";
        histJson += "\"batteryVoltage\":" + String(rec.batteryVoltage, 2) + ",";
        histJson += "\"batteryCurrent\":" + String(rec.batteryCurrent, 2) + ",";
        histJson += "\"batterySoc\":" + String(rec.batterySoc) + ",";
        histJson += "\"cellVoltages\":[" + String(rec.cellVoltages[0], 3) + "," + String(rec.cellVoltages[1], 3) + "," + String(rec.cellVoltages[2], 3) + "," + String(rec.cellVoltages[3], 3) + "],";
        histJson += "\"solarVoltage\":" + String(rec.solarVoltage, 2) + ",";
        histJson += "\"gridPresent\":" + String(rec.gridPresent ? "true" : "false") + ",";
        histJson += "\"inverterState\":" + String(rec.inverterState ? "true" : "false") + ",";
        histJson += "\"smpsState\":" + String(rec.smpsState ? "true" : "false") + ",";
        histJson += "\"mode\":\"" + String(rec.mode) + "\",";
        histJson += "\"offlineBuffered\":true";
        histJson += "}";

        if (mqttClient.publish(TOPIC_HISTORY, histJson.c_str(), false)) {
          offlineHistoryHead = (offlineHistoryHead + 1) % MAX_OFFLINE_HISTORY;
          offlineHistoryCount--;
        }
      }
    }

    // Yield 50ms on Core 0 so MQTT callbacks respond within milliseconds while keeping CPU cool
    vTaskDelay(50 / portTICK_PERIOD_MS);
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
    unsigned long epoch = timeClient.getEpochTime();
    if (epoch > 1700000000UL) {
      cachedEpoch = epoch;
    }
    static unsigned long lastRtcSync = 0;
    if (rtcFound && (millis() - lastRtcSync >= 3600000 || lastRtcSync == 0)) {
      if (epoch > 1767225600) { 
        rtc.adjust(DateTime(epoch)); 
        lastRtcSync = millis();
      }
    }
  } else if (rtcFound) {
    DateTime now = rtc.now();
    if (now.unixtime() > 1700000000UL) {
      cachedEpoch = now.unixtime();
    }
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

  // Offline / Physical Switch Priority Recovery:
  // If someone physically toggles a switch on the enclosure, automatically clear Web Override (-1)
  if (!switchTrackerInitialized) {
    prevRawManual = rawManual;
    prevRawEco = rawEco;
    prevRawPcut = rawPcut;
    switchTrackerInitialized = true;
  } else if (rawManual != prevRawManual || rawEco != prevRawEco || rawPcut != prevRawPcut) {
    prevRawManual = rawManual;
    prevRawEco = rawEco;
    prevRawPcut = rawPcut;
    if (webModeOverride != -1) {
      webModeOverride = -1; // Hand control back to physical switches immediately
      forceImmediatePublish = true;
    }
  }

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

  // Power-cut timer: runs in PCUT and ECO+PCUT mode only when inverter is OFF and battery has enough voltage (>= 12.5V) to start
  if (!isGrid && !inverterState && pcutMode && (batVolt >= 12.5)) {
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
          powerCutTimerActive = false;
          powerCutTime = 0;
        }
        if (batVolt <= 12.0) inverterState = false;
      }
    } else {
      if (gridReturnTimerActive && (millis() - gridReturnTime >= TIMER_DELAY_MS)) {
        inverterState = false;
        gridReturnTimerActive = false;
        gridReturnTime = 0;
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
        powerCutTimerActive = false;
        powerCutTime = 0;
      }
      if (batVolt <= 12.0) inverterState = false; 
    } else {
      if (gridReturnTimerActive && (millis() - gridReturnTime >= TIMER_DELAY_MS)) {
        inverterState = false; 
        gridReturnTimerActive = false;
        gridReturnTime = 0;
      }
    }
  } 
  else {
    modeString = "POWER OFF";
    inverterState = false;
  }

  // ---------------------------------------------------------
  // ⚡ SMPS EXTRA CHARGER LOGIC (STRICT INVERTER-OFF INTERLOCK IN ALL MODES)
  // ---------------------------------------------------------
  // Automatic charging is allowed in ANY non-manual mode ONLY when Inverter is OFF and no battery fault exists
  bool allowAutoCharging = (errorString == "") && !inverterState && !manualMode;

  // Reset top-up Done flags when we are outside the respective time windows
  if (currentHour != 17) {
    topup530Done = false;
  }
  if (currentHour != 1) {
    topup1amDone = false;
  }

  // Strict Hardware Interlock: if Inverter is ON, fault exists, or battery reached 15.5V stop threshold, cut off charging
  if (inverterState || errorString != "" || batVolt >= BAT_CHARGE_STOP_THRESHOLD) {
    forceChargingActive = false;
    manualSmpsOverride = false;
  }

  // --- Flatline Detection Logic (Runs for all active charging requests while Inverter is OFF) ---
  bool anyChargingRequest = !inverterState && (errorString == "") && (
    forceChargingActive || (manualMode && manualSmpsOverride) || topup530Active || topup1amActive || normalChargingActive
  );
  if (anyChargingRequest) {
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

  if (inverterState || errorString != "") {
    // Hardware Interlock: SMPS Charger MUST remain OFF whenever Inverter is ON (in ANY mode)
    topup530Active = false;
    topup1amActive = false;
    normalChargingActive = false;
    forceChargingActive = false;
    manualSmpsOverride = false;
    smpsState = false;
  }
  else if (forceChargingActive) {
    smpsState = true;
    if (batVolt >= BAT_CHARGE_STOP_THRESHOLD || flatlineDetected) {
      forceChargingActive = false;
      smpsState = false;
    }
  }
  else if (manualMode) {
    topup530Active = false;
    topup1amActive = false;
    normalChargingActive = false;
    smpsState = manualSmpsOverride;
    if (smpsState && (batVolt >= BAT_CHARGE_STOP_THRESHOLD || flatlineDetected)) {
      manualSmpsOverride = false;
      smpsState = false;
    }
  }
  else if (allowAutoCharging) {
    
    // 1. Mandatory 5:30 PM top-up charge (Evening Prep Logic)
    if ((currentHour == 17 && currentMinute >= 30) && batVolt < BAT_TOPUP_START_THRESHOLD && !topup530Done && !topup1amActive && !normalChargingActive) {
      topup530Active = true;
    }
    
    // 2. Mandatory 1:00 AM battery top-up charge (Night Emergency Backup)
    if (currentHour == 1 && batVolt < BAT_TOPUP_START_THRESHOLD && !topup1amDone && !topup530Active && !normalChargingActive) {
      topup1amActive = true;
    }
    
    // 3. Charge when battery level drops below normal threshold (Anytime Inverter is OFF)
    if (batVolt <= BAT_CHARGE_START_THRESHOLD && !topup530Active && !topup1amActive) {
      normalChargingActive = true;
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

  setCurrentModeSafe(modeString.c_str());

  // Wake MQTT immediately on any relay or grid transition even during 15-min idle sleep
  static bool prevPublishedInv = false;
  static bool prevPublishedSmps = false;
  static bool prevPublishedGrid = false;
  static bool transitionTrackInit = false;
  if (!transitionTrackInit) {
    prevPublishedInv = inverterState;
    prevPublishedSmps = smpsState;
    prevPublishedGrid = isGrid;
    transitionTrackInit = true;
  } else if (prevPublishedInv != inverterState || prevPublishedSmps != smpsState || prevPublishedGrid != isGrid) {
    prevPublishedInv = inverterState;
    prevPublishedSmps = smpsState;
    prevPublishedGrid = isGrid;
    forceImmediatePublish = true;
  }

  // ---------------------------------------------------------
  // OLED DISPLAY GRAPHICS LAYOUT (Skipped safely if OLED is disconnected)
  // ---------------------------------------------------------
  if (oledFound) {
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
        else if (!isGrid && !inverterState && batVolt < 12.5) display.print(F("LOW BAT (<12.5V)"));
        else display.print(F("SYSTEM NORMAL"));
      }
    }

    display.display();
  }
  delay(200); 
}
