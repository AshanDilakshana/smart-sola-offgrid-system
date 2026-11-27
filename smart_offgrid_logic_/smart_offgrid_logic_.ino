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
#include <esp_task_wdt.h>
#include <esp_idf_version.h>
#include "JK_BMS.h"
#include "aws_certs.h"

JKBMS jkbms;
unsigned long lastBmsRequest = 0;

// OLED Display Settings (Locked to 100kHz I2C both during & after transfers for high EMI immunity near Inverter/Relays)
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1
#define I2C_SDA_PIN   21
#define I2C_SCL_PIN   22
#define I2C_CLOCK_HZ  100000UL
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET, I2C_CLOCK_HZ, I2C_CLOCK_HZ);
bool oledFound = false;

// RTC Setting
RTC_DS3231 rtc;
bool rtcFound = false;

// WiFi Credentials
const char* ssid = "SLT FIBER";
const char* password = "@Ashan20030118";

// Firmware Versioning
const char* FIRMWARE_VERSION = "v1.0.6";

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

// NTP Time Client (Executed ONLY on Core 0 to prevent dual-core DNS/lwIP UDP deadlock during router boot)
WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "pool.ntp.org", 19800, 600000); // 10-min NTP sync interval on Core 0

// Web Server on Port 80 (Serviced on Core 0 so Core 1 never touches TCP/IP sockets)
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
const unsigned long TIMER_DELAY_MS = 120000UL; 
const int TIMER_DELAY_SEC = 120;

// --- Charging Voltage Configuration ---
const float BAT_CHARGE_START_THRESHOLD = 12.5f; // Start normal charging below this voltage (Default: 12.5V)
const float BAT_CHARGE_STOP_THRESHOLD  = 15.5f; // Stop charging when battery reaches this voltage (Below inverter OVP 15.5V)
const float BAT_TOPUP_START_THRESHOLD  = 14.5f; // Start top-up charging if battery drops below this voltage

// Timer, Toggle & State Variables
unsigned long powerCutTime = 0;
unsigned long gridReturnTime = 0;
unsigned long statusToggleTime = 0;
bool powerCutTimerActive = false;
bool gridReturnTimerActive = false;
volatile bool inverterState = false;
volatile bool smpsState = false;
volatile bool topup530Active = false;
volatile bool topup1amActive = false;
volatile bool normalChargingActive = false;
bool topup530Done = false;         // Prevents evening top-up from looping
bool topup1amDone = false;         // Prevents morning top-up from looping
int statusPage = 0; 
volatile int activeCountdownSecs = -1;

// Dual-Core Thread-Safe Shared State (Core 0 Network <-> Core 1 Control/OLED/I2C)
portMUX_TYPE stateMux = portMUX_INITIALIZER_UNLOCKED;
char currentModeBuf[20] = "POWER OFF";
volatile unsigned long cachedEpoch = 0;
volatile unsigned long cachedEpochMillis = 0;
volatile unsigned long pendingRtcAdjustEpoch = 0;
volatile bool cachedWifiConnected = false;
volatile int cachedRssi = -100;
char cachedIpBuf[20] = "0.0.0.0";

// Cross-Core Watchdog Heartbeats (Core 0 monitors Core 1; Core 1 has 15s Hardware TWDT)
volatile unsigned long lastCore1LoopTick = 0;
volatile unsigned long lastCore0LoopTick = 0;
const unsigned long CORE1_FREEZE_TIMEOUT_MS = 15000UL; // 15s max freeze tolerance before emergency reset

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

void setCachedIpSafe(const char* ipStr) {
  if (!ipStr) return;
  portENTER_CRITICAL(&stateMux);
  strncpy(cachedIpBuf, ipStr, sizeof(cachedIpBuf) - 1);
  cachedIpBuf[sizeof(cachedIpBuf) - 1] = '\0';
  portEXIT_CRITICAL(&stateMux);
}

void getCachedIpSafe(char* out, size_t maxLen) {
  if (maxLen == 0) return;
  portENTER_CRITICAL(&stateMux);
  strncpy(out, cachedIpBuf, maxLen - 1);
  out[maxLen - 1] = '\0';
  portEXIT_CRITICAL(&stateMux);
}

// Web Control & Override Variables
// webModeOverride: -1 = Auto (Physical Switches), 0 = POWER OFF, 1 = ECO MODE, 2 = POWER CUT, 3 = ECO+POWER CUT, 4 = MANUAL
volatile int webModeOverride = -1;
volatile bool forceChargingActive = false;
volatile bool manualInverterOverride = false;
volatile bool manualSmpsOverride = false;

// --- Physical Switch Change Tracking (For Offline & Emergency Switch Priority) ---
bool prevRawManual = false;
bool prevRawEco = false;
bool prevRawPcut = false;
bool switchTrackerInitialized = false;

// --- Flatline Detection (dV/dt) Variables ---
unsigned long lastVoltageCheckTime = 0;
float lastRecordedVoltage = 0.0f;
volatile bool flatlineDetected = false;
const unsigned long VOLTAGE_CHECK_INTERVAL = 300000UL; // 5 minutes (300,000 ms)
const float DVDT_START_VOLTAGE = 13.5f; // Only check after reaching 13.5V

// --- Software Grid Debounce Variables ---
unsigned long lastGridDebounceTime = 0;
bool lastGridRawState = false;
volatile bool debouncedGridState = false;
const unsigned long GRID_DEBOUNCE_DELAY_MS = 1000UL; // 1 second debounce to filter grid noise

// --- Super Strong Noise Filter Variables ---
volatile float lastBatVolt = 0.0f;
volatile float lastSolVolt = 0.0f;

// Function declarations for API & Tasks
void handleGetStatus();
void handleSetMode();
void handleSetCharge();
void handleSetRelay();
void handleOTAUpdate();
void syncFirebaseTask(void * pvParameters);
void mqttCallback(char* topic, byte* payload, unsigned int length);
void recoverI2CBus(bool reinitOled);

unsigned long lastAppHeartbeatTime = 0;
char lastReceivedHeartbeatBuf[32] = ""; // Tracks if heartbeat timestamp changed on Core 0
const unsigned long ACTIVE_SESSION_TIMEOUT_MS = 90000UL; // 90s active live-stream window (renewed at ~65s right before sleep)
volatile bool isAppSessionActive = true;
TaskHandle_t FirebaseTaskHandle;

volatile bool forceImmediatePublish = false;
char pendingOtaUrlBuf[256] = "";
volatile bool hasPendingOta = false;
volatile bool otaInProgress = false;

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
const unsigned long HISTORY_LOG_INTERVAL = 900000UL; // 15 minutes (900,000 ms)

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

const int MAX_OFFLINE_HISTORY = 64; // Stores up to 64 adaptive snapshots (16h idle or 2h+ 2-min power-cut discharge) in RAM while offline
OfflineHistoryRecord offlineHistoryBuffer[MAX_OFFLINE_HISTORY];
int offlineHistoryHead = 0;
int offlineHistoryCount = 0;
volatile bool forceOfflineSnapshot = false;

// Thread-safe Unix Epoch getter (Extrapolates smoothly using millis() between RTC/NTP updates without touching I2C or UDP)
unsigned long getCurrentEpoch() {
  unsigned long baseEp = cachedEpoch;
  unsigned long baseMs = cachedEpochMillis;
  if (baseEp > 1700000000UL) {
    return baseEp + ((millis() - baseMs) / 1000UL);
  }
  return millis() / 1000UL;
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

// Zero-fragmentation JSON builder using stack buffer & snprintf (Safe across multi-week uptime)
void buildStatusJsonBuffer(char* outBuf, size_t maxLen) {
  char modeSnap[20];
  char ipSnap[20];
  getCurrentModeSafe(modeSnap, sizeof(modeSnap));
  getCachedIpSafe(ipSnap, sizeof(ipSnap));

  int cdVal = activeCountdownSecs >= 0 ? activeCountdownSecs : 0;

  snprintf(
    outBuf,
    maxLen,
    "{\"epoch\":%lu,\"batteryVoltage\":%.2f,\"batteryCurrent\":%.2f,\"batterySoc\":%d,"
    "\"cellVoltages\":[%.3f,%.3f,%.3f,%.3f],\"solarVoltage\":%.2f,"
    "\"gridPresent\":%s,\"inverterState\":%s,\"smpsState\":%s,"
    "\"modeString\":\"%s\",\"webModeOverride\":%d,\"countdown\":%d,"
    "\"forceChargingActive\":%s,\"topup530Active\":%s,\"topup1amActive\":%s,"
    "\"normalChargingActive\":%s,\"flatlineDetected\":%s,"
    "\"wifiConnected\":%s,\"mqttConnected\":%s,\"rssi\":%d,"
    "\"ip\":\"%s\",\"firmwareVersion\":\"%s\",\"sessionActive\":%s}",
    getCurrentEpoch(),
    (double)lastBatVolt,
    (double)jkbms.current,
    jkbms.soc,
    (double)jkbms.cellVoltages[0],
    (double)jkbms.cellVoltages[1],
    (double)jkbms.cellVoltages[2],
    (double)jkbms.cellVoltages[3],
    (double)lastSolVolt,
    debouncedGridState ? "true" : "false",
    inverterState ? "true" : "false",
    smpsState ? "true" : "false",
    modeSnap,
    webModeOverride,
    cdVal,
    forceChargingActive ? "true" : "false",
    topup530Active ? "true" : "false",
    topup1amActive ? "true" : "false",
    normalChargingActive ? "true" : "false",
    flatlineDetected ? "true" : "false",
    cachedWifiConnected ? "true" : "false",
    mqttClient.connected() ? "true" : "false",
    cachedRssi,
    ipSnap,
    FIRMWARE_VERSION,
    isAppSessionActive ? "true" : "false"
  );
}

// ---------------------------------------------------------
// 🛡️ I2C BUS ANTI-LOCKUP & AUTO-RECOVERY (CORE 1 ONLY)
// ---------------------------------------------------------
// Releases stuck SDA line (caused by relay/inverter EMI spike) by pulsing SCL 9 times
// and re-initializing the ESP32 I2C peripheral with a strict 50ms hardware timeout.
void recoverI2CBus(bool reinitOled) {
  Wire.end();
  pinMode(I2C_SDA_PIN, INPUT_PULLUP);
  pinMode(I2C_SCL_PIN, OUTPUT);
  digitalWrite(I2C_SCL_PIN, HIGH);
  delayMicroseconds(10);

  // Clock up to 9 pulses on SCL if a slave (OLED or DS3231) is holding SDA low mid-byte
  for (int i = 0; i < 9 && digitalRead(I2C_SDA_PIN) == LOW; i++) {
    digitalWrite(I2C_SCL_PIN, LOW);
    delayMicroseconds(10);
    digitalWrite(I2C_SCL_PIN, HIGH);
    delayMicroseconds(10);
  }

  // Generate I2C STOP condition
  pinMode(I2C_SDA_PIN, OUTPUT);
  digitalWrite(I2C_SDA_PIN, LOW);
  delayMicroseconds(10);
  digitalWrite(I2C_SCL_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(I2C_SDA_PIN, HIGH);
  delayMicroseconds(10);

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, I2C_CLOCK_HZ);
  Wire.setTimeOut(50); // Strict 50ms hardware timeout: I2C can NEVER hang Core 1!

  if (reinitOled && oledFound) {
    display.begin(SSD1306_SWITCHCAPVCC, 0x3C, false, false);
  }
}

void initHardwareWatchdogOnCore1() {
#if ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t twdt_config = {
    .timeout_ms = 15000,
    .idle_core_mask = 0,
    .trigger_panic = true
  };
  if (esp_task_wdt_reconfigure(&twdt_config) != ESP_OK) {
    esp_task_wdt_init(&twdt_config);
  }
  esp_task_wdt_add(NULL);
#else
  esp_task_wdt_init(15, true);
  esp_task_wdt_add(NULL);
#endif
}

void setup() {
  Serial.begin(115200);

  // Active-Low Relay Boot Glitch Fix (Immediate safe state before any peripheral init)
  digitalWrite(INV_RELAY, HIGH);
  digitalWrite(SMPS_RELAY, HIGH);
  pinMode(INV_RELAY, OUTPUT);
  pinMode(SMPS_RELAY, OUTPUT);

  // Sensing and Switch Pins (INPUT_PULLDOWN prevents floating HIGH when optocoupler turns off)
  pinMode(GRID_SENS, INPUT_PULLDOWN);
  pinMode(ECO_SWITCH, INPUT_PULLUP);
  pinMode(PCUT_SWITCH, INPUT_PULLUP);
  pinMode(MANUAL_SWITCH, INPUT_PULLUP);

  // Initialize JK BMS on Serial2 (RX=4, TX=5) with enlarged 1KB RX FIFO
  jkbms.begin(Serial2, 4, 5);

  // ADC Settings
  analogSetAttenuation(ADC_11db);

  // Initialize I2C Bus at 100kHz with 50ms timeout & bus clear before OLED/RTC init
  recoverI2CBus(false);

  // Initialize OLED (Non-blocking: system continues autonomously even if OLED wire is loose)
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C, false, false)) {
    Serial.println(F("SSD1306 allocation failed - continuing without OLED"));
    oledFound = false;
  } else {
    oledFound = true;
    display.clearDisplay();
    display.display();
  }

  // Initialize RTC
  if (!rtc.begin()) {
    Serial.println(F("RTC Not Found!"));
    rtcFound = false;
  } else {
    rtcFound = true;
    DateTime now = rtc.now();
    unsigned long rtcEp = now.unixtime();
    if (rtcEp > 1700000000UL && rtcEp < 4102444800UL) {
      cachedEpoch = rtcEp;
      cachedEpochMillis = millis();
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
    mqttSecureClient.setHandshakeTimeout(5);
    mqttClient.setClient(mqttSecureClient);
    mqttClient.setServer(AWS_IOT_ENDPOINT, AWS_IOT_PORT);
    Serial.println(F("MQTT Configured with AWS IoT Core mTLS Certificates (Port 8883)"));
  } else {
    useAwsMtls = false;
    mqttClient.setClient(mqttWifiClient);
    mqttClient.setServer(mqtt_server, mqtt_port);
    Serial.println(F("MQTT Configured for Standard TCP Broker"));
  }
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(1024); // Ensure 1KB buffer for full JSON telemetry
  mqttClient.setKeepAlive(60);    // 60s MQTT keep-alive (4x lower ping rate for free-tier limits)
  mqttClient.setSocketTimeout(3);

  // Configure Local Web Server & CORS (Serviced on Core 0 so Core 1 never blocks on HTTP sockets)
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
  Serial.println(F("HTTP Web Server Started"));

  lastCore1LoopTick = millis();
  lastCore0LoopTick = millis();

  // Enable 15-second Hardware Task Watchdog on Core 1 (Control Loop)
  initHardwareWatchdogOnCore1();

  // Start All Network / MQTT / NTP / HTTP Services on Core 0
  // Core 1 is 100% dedicated to Relays, Timers, JK BMS UART, and I2C OLED/RTC with ZERO network calls!
  xTaskCreatePinnedToCore(
    syncFirebaseTask,   // Task function
    "NetworkSyncTask",  // Name of task
    10240,              // 10KB stack size for TLS + JSON + HTTP
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
    lastBatVolt = 0.0f;
  }
  return lastBatVolt;
}

float getSolarVoltage() {
  // Solar panels are disconnected. Return 0.0V to prevent floating pin readings.
  return 0.0f;
}

// ---------------------------------------------------------
// Draw WiFi Signal Bars (Reads Core 0 cached RSSI - ZERO Wi-Fi driver lock on Core 1)
// ---------------------------------------------------------
void drawWiFiBars(int x, int y) {
  if (!cachedWifiConnected) {
    display.setCursor(x, y);
    display.setTextSize(1);
    display.print(F("X"));
    return;
  }
  int rssi = cachedRssi;
  int bars = 0;
  if (rssi > -55) bars = 4;
  else if (rssi <= -55 && rssi > -65) bars = 3;
  else if (rssi <= -65 && rssi > -75) bars = 2;
  else if (rssi <= -75 && rssi >= -88) bars = 1;
  
  if (bars >= 1) display.fillRect(x,     y + 6, 2, 2, SSD1306_WHITE);
  if (bars >= 2) display.fillRect(x + 3, y + 4, 2, 4, SSD1306_WHITE);
  if (bars >= 3) display.fillRect(x + 6, y + 2, 2, 6, SSD1306_WHITE);
  if (bars >= 4) display.fillRect(x + 9, y,     2, 8, SSD1306_WHITE);
}

// ---------------------------------------------------------
// 🌐 LOCAL WEB SERVER API HANDLERS (RUNS ON CORE 0)
// ---------------------------------------------------------
void handleGetStatus() {
  char jsonBuf[640];
  buildStatusJsonBuffer(jsonBuf, sizeof(jsonBuf));
  server.send(200, "application/json", jsonBuf);
}

void handleSetMode() {
  if (server.hasArg("mode")) {
    webModeOverride = server.arg("mode").toInt();
    forceImmediatePublish = true;
  }
  char resp[64];
  snprintf(resp, sizeof(resp), "{\"success\":true,\"webModeOverride\":%d}", webModeOverride);
  server.send(200, "application/json", resp);
}

void handleSetCharge() {
  if (server.hasArg("active")) {
    String act = server.arg("active");
    forceChargingActive = (act == "true" || act == "1");
  } else {
    forceChargingActive = !forceChargingActive;
  }
  forceImmediatePublish = true;
  char resp[64];
  snprintf(resp, sizeof(resp), "{\"success\":true,\"forceChargingActive\":%s}", forceChargingActive ? "true" : "false");
  server.send(200, "application/json", resp);
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
// 🌐 ALL NETWORKING, MQTT, NTP & HTTP SERVER TASK (CORE 0)
// ---------------------------------------------------------
void syncFirebaseTask(void * pvParameters) {
  unsigned long lastWifiCheck = 0;
  unsigned long lastMqttReconnectAttempt = 0;
  unsigned long lastStatusPublish = 0;
  unsigned long lastNtpSyncAttempt = 0;
  unsigned long lastWifiCacheUpdate = 0;

  for (;;) {
    unsigned long now = millis();
    lastCore0LoopTick = now;

    // 0. Cross-Core Freeze Watchdog: If Core 1 (Control/OLED Loop) ever stalls for >15 seconds,
    //    immediately place relays into safe state and reboot ESP32 so Inverter NEVER stays stuck ON!
    unsigned long core1Age = now - lastCore1LoopTick;
    if (core1Age > CORE1_FREEZE_TIMEOUT_MS) {
      Serial.println(F("CRITICAL: Core 1 freeze detected (>15s)! Disengaging charger & restarting ESP32..."));
      digitalWrite(SMPS_RELAY, HIGH);
      delay(50);
      ESP.restart();
    }

    // 1. Adaptive Offline RAM History Buffering (Records ONLY when Wi-Fi or MQTT is offline!)
    //    - Discharging (Inverter ON): every 2 min (120,000 ms)
    //    - Charging (SMPS ON): every 5 min (300,000 ms)
    //    - Idle Standby: every 15 min (900,000 ms)
    //    - Plus instant snapshot on any Relay / Grid state change while offline!
    bool wifiUp = (WiFi.status() == WL_CONNECTED);
    cachedWifiConnected = wifiUp;
    bool cloudOnline = (wifiUp && mqttClient.connected());

    if (!cloudOnline) {
      unsigned long offlineIntervalMs = HISTORY_LOG_INTERVAL; // 15m idle
      if (inverterState || jkbms.current < -0.05f) {
        offlineIntervalMs = 120000UL; // 2m discharging during power cut
      } else if (smpsState || jkbms.current > 0.05f) {
        offlineIntervalMs = 300000UL; // 5m charging
      }
      if (jkbms.dataValid && lastBatVolt > 5.0f && (forceOfflineSnapshot || lastHistoryLogTime == 0 || (now - lastHistoryLogTime >= offlineIntervalMs))) {
        forceOfflineSnapshot = false;
        lastHistoryLogTime = now;
        enqueueOfflineHistory();
      }
    } else {
      forceOfflineSnapshot = false;
    }

    // 2. Non-Blocking Wi-Fi Connection Supervision & Cached RSSI/IP Update for Core 1
    if (!wifiUp) {
      cachedRssi = -100;
      if (now - lastWifiCheck >= 5000UL) {
        lastWifiCheck = now;
        WiFi.reconnect();
      }
      vTaskDelay(100 / portTICK_PERIOD_MS);
      continue;
    }

    if (now - lastWifiCacheUpdate >= 1000UL) {
      lastWifiCacheUpdate = now;
      cachedRssi = WiFi.RSSI();
      IPAddress ip = WiFi.localIP();
      char ipStr[20];
      snprintf(ipStr, sizeof(ipStr), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
      setCachedIpSafe(ipStr);
    }

    // 3. Service Local HTTP Web Server on Core 0 (Keeps Core 1 100% free of TCP socket waits)
    server.handleClient();

    // 4. Handle Pending OTA Firmware Update (Only when triggered)
    char otaUrlBuf[256];
    if (takePendingOtaUrlSafe(otaUrlBuf, sizeof(otaUrlBuf))) {
      String urlToFlash = String(otaUrlBuf);
      Serial.println("Starting OTA Update from: " + urlToFlash);
      otaInProgress = true;

      // CRITICAL: Disconnect MQTT & stop AWS mTLS socket FIRST to free ~50KB contiguous RAM!
      // Without this, opening a second simultaneous WiFiClientSecure TLS session to GitHub fails with OOM.
      if (mqttClient.connected()) {
        mqttClient.disconnect();
      }
      if (useAwsMtls) {
        mqttSecureClient.stop();
      } else {
        mqttWifiClient.stop();
      }
      vTaskDelay(300 / portTICK_PERIOD_MS);

      WiFiClientSecure otaClient;
      otaClient.setInsecure();
      otaClient.setTimeout(15); // 15s timeout for weak Wi-Fi (-87 dBm)
      httpUpdate.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
      httpUpdate.rebootOnUpdate(true);

      t_httpUpdate_return ret = httpUpdate.update(otaClient, urlToFlash);
      if (ret == HTTP_UPDATE_OK) {
        Serial.println(F("OTA Update Successful! Restarting ESP32..."));
        ESP.restart();
      } else {
        otaInProgress = false;
        Serial.printf("OTA Update Failed (%d): %s\n", httpUpdate.getLastError(), httpUpdate.getLastErrorString().c_str());
        lastMqttReconnectAttempt = 0; // Reconnect MQTT immediately
      }
    }

    // 5. Non-Blocking MQTT Reconnection with Last Will & Testament (LWT)
    if (!mqttClient.connected()) {
      if (now - lastMqttReconnectAttempt >= 5000UL) {
        lastMqttReconnectAttempt = now;
        char clientId[40];
        snprintf(clientId, sizeof(clientId), "ESP32_SmartOffGrid_%08X", (uint32_t)ESP.getEfuseMac());

        bool connected = false;
        if (strlen(mqtt_user) > 0) {
          connected = mqttClient.connect(
            clientId,
            mqtt_user,
            mqtt_pass,
            TOPIC_AVAILABILITY,
            0,
            false,
            "offline"
          );
        } else {
          connected = mqttClient.connect(
            clientId,
            TOPIC_AVAILABILITY,
            0,
            false,
            "offline"
          );
        }

        if (connected) {
          Serial.println(F("MQTT Connected! Publishing online availability & subscribing..."));
          mqttClient.publish(TOPIC_AVAILABILITY, "online", false);
          mqttClient.subscribe(TOPIC_COMMANDS, 1);
          forceImmediatePublish = true;
        }
      }
    } else {
      // Process incoming MQTT packets instantly
      mqttClient.loop();

      // 6. Safe NTP Time Sync on Core 0 (Runs ONLY after MQTT is connected, proving WAN & DNS are ready!)
      //    This completely eliminates the DNS/UDP deadlock when the SLT FIBER router boots up after a power cut!
      if (lastNtpSyncAttempt == 0 || (now - lastNtpSyncAttempt >= 600000UL)) {
        lastNtpSyncAttempt = now;
        if (timeClient.update()) {
          unsigned long ntpEp = timeClient.getEpochTime();
          if (ntpEp > 1700000000UL && ntpEp < 4102444800UL) {
            cachedEpoch = ntpEp;
            cachedEpochMillis = millis();
            pendingRtcAdjustEpoch = ntpEp; // Signal Core 1 to update DS3231 RTC over I2C
          }
        }
      }

      // 7. Evaluate 90-Second Active Dashboard Session Timeout (renewed at ~65s right before sleep)
      if (lastAppHeartbeatTime == 0) lastAppHeartbeatTime = now;
      isAppSessionActive = ((now - lastAppHeartbeatTime) < ACTIVE_SESSION_TIMEOUT_MS);

      // 8. Rate-Limit-Friendly Adaptive MQTT Telemetry:
      //    - Active dashboard open: 2s live updates
      //    - Background / Discharging (Inverter ON or load current): every 2 min (120,000 ms)
      //    - Background / Charging (SMPS ON or charge current): every 5 min (300,000 ms)
      //    - Background / Idle Standby: every 15 min (900,000 ms)
      unsigned long publishIntervalMs = 900000UL;
      if (isAppSessionActive) {
        publishIntervalMs = 2000UL;
      } else if (inverterState || jkbms.current < -0.05f) {
        publishIntervalMs = 120000UL;
      } else if (smpsState || jkbms.current > 0.05f) {
        publishIntervalMs = 300000UL;
      }

      if (forceImmediatePublish || (now - lastStatusPublish >= publishIntervalMs)) {
        forceImmediatePublish = false;
        lastStatusPublish = now;
        char statusPayload[640];
        buildStatusJsonBuffer(statusPayload, sizeof(statusPayload));
        mqttClient.publish(TOPIC_STATUS, statusPayload, false);
      }

      // 9. Flush Any Offline-Buffered 15-Minute History Logs to Backend -> MongoDB
      if (offlineHistoryCount > 0) {
        OfflineHistoryRecord &rec = offlineHistoryBuffer[offlineHistoryHead];

        char histJson[420];
        snprintf(
          histJson,
          sizeof(histJson),
          "{\"epoch\":%lu,\"batteryVoltage\":%.2f,\"batteryCurrent\":%.2f,\"batterySoc\":%d,"
          "\"cellVoltages\":[%.3f,%.3f,%.3f,%.3f],\"solarVoltage\":%.2f,"
          "\"gridPresent\":%s,\"inverterState\":%s,\"smpsState\":%s,"
          "\"mode\":\"%s\",\"offlineBuffered\":true}",
          rec.epoch,
          (double)rec.batteryVoltage,
          (double)rec.batteryCurrent,
          rec.batterySoc,
          (double)rec.cellVoltages[0],
          (double)rec.cellVoltages[1],
          (double)rec.cellVoltages[2],
          (double)rec.cellVoltages[3],
          (double)rec.solarVoltage,
          rec.gridPresent ? "true" : "false",
          rec.inverterState ? "true" : "false",
          rec.smpsState ? "true" : "false",
          rec.mode
        );

        if (mqttClient.publish(TOPIC_HISTORY, histJson, false)) {
          offlineHistoryHead = (offlineHistoryHead + 1) % MAX_OFFLINE_HISTORY;
          offlineHistoryCount--;
        }
      }
    }

    // Yield 50ms on Core 0 so MQTT callbacks & HTTP requests respond within milliseconds
    vTaskDelay(50 / portTICK_PERIOD_MS);
  }
}

// ---------------------------------------------------------
// ⚡ CORE 1: DETERMINISTIC HARDWARE CONTROL, TIMERS & OLED
//    (100% ISOLATED FROM WI-FI / DNS / UDP / TCP SOCKETS)
// ---------------------------------------------------------
void loop() {
  unsigned long nowMs = millis();

  // Feed both Cross-Core Watchdog and Hardware Task Watchdog (TWDT)
  lastCore1LoopTick = nowMs;
  esp_task_wdt_reset();

  // Read incoming BMS data constantly from 1KB UART2 buffer
  jkbms.readData(Serial2);

  // Request new data from BMS every 2 seconds
  if (nowMs - lastBmsRequest >= 2000UL) {
    jkbms.requestData(Serial2);
    lastBmsRequest = nowMs;
  }

  // Apply any pending NTP->RTC time adjustment queued by Core 0 (at most once per hour)
  static unsigned long lastRtcSyncMs = 0;
  unsigned long ntpToApply = pendingRtcAdjustEpoch;
  if (ntpToApply > 1700000000UL) {
    pendingRtcAdjustEpoch = 0;
    if (rtcFound && (lastRtcSyncMs == 0 || (nowMs - lastRtcSyncMs >= 3600000UL))) {
      rtc.adjust(DateTime(ntpToApply));
      lastRtcSyncMs = nowMs;
    }
  }

  // Poll DS3231 RTC at most once per second (1,000ms) instead of every 200ms to minimize I2C bus load
  static unsigned long lastRtcReadMs = 0;
  static int cachedHour = 12;
  static int cachedMinute = 0;
  static char displayTimeBuf[8] = "--:--";

  if (lastRtcReadMs == 0 || (nowMs - lastRtcReadMs >= 1000UL)) {
    lastRtcReadMs = nowMs;

    // Auto-recover I2C bus if SDA pin is stuck LOW due to Inverter/Relay EMI
    if (digitalRead(I2C_SDA_PIN) == LOW) {
      recoverI2CBus(true);
    }

    bool timeResolved = false;
    if (rtcFound) {
      DateTime rtcNow = rtc.now();
      // Validate DS3231 response in case of momentary I2C EMI noise
      if (rtcNow.year() >= 2024 && rtcNow.year() <= 2099 && rtcNow.hour() < 24 && rtcNow.minute() < 60) {
        unsigned long rtcEp = rtcNow.unixtime();
        if (rtcEp > 1700000000UL) {
          cachedEpoch = rtcEp;
          cachedEpochMillis = nowMs;
        }
        cachedHour = rtcNow.hour();
        cachedMinute = rtcNow.minute();
        snprintf(displayTimeBuf, sizeof(displayTimeBuf), "%02d:%02d", cachedHour, cachedMinute);
        timeResolved = true;
      } else {
        // I2C read returned corrupted RTC data -> recover I2C bus immediately
        recoverI2CBus(true);
      }
    }

    if (!timeResolved) {
      unsigned long ep = getCurrentEpoch();
      if (ep > 1700000000UL) {
        // Convert UTC epoch (or IST-offset epoch from NTPClient) to HH:MM
        unsigned long daySecs = ep % 86400UL;
        cachedHour = (int)(daySecs / 3600UL);
        cachedMinute = (int)((daySecs % 3600UL) / 60UL);
        snprintf(displayTimeBuf, sizeof(displayTimeBuf), "%02d:%02d", cachedHour, cachedMinute);
      }
    }
  }

  int currentHour = cachedHour;
  int currentMinute = cachedMinute;

  float batVolt = getBatteryVoltage();
  float solVolt = getSolarVoltage(); 
  
  // Software debounce for Grid Sensing to prevent noise triggers
  bool gridRaw = digitalRead(GRID_SENS);
  if (gridRaw != lastGridRawState) {
    lastGridDebounceTime = nowMs;
    lastGridRawState = gridRaw;
  }
  if ((nowMs - lastGridDebounceTime) >= GRID_DEBOUNCE_DELAY_MS) {
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

  int activeOverride = webModeOverride;
  if (activeOverride == 0) { // POWER OFF
    manualMode = false; ecoMode = false; pcutMode = false;
  } else if (activeOverride == 1) { // ECO MODE
    manualMode = false; ecoMode = true; pcutMode = false;
  } else if (activeOverride == 2) { // POWER CUT
    manualMode = false; ecoMode = false; pcutMode = true;
  } else if (activeOverride == 3) { // ECO+POWER CUT
    manualMode = false; ecoMode = true; pcutMode = true;
  } else if (activeOverride == 4) { // MANUAL OVERRIDE
    manualMode = true; ecoMode = false; pcutMode = false;
  }
  
  const char* modeString = "POWER OFF"; 
  const char* errorString = ""; 

  if (batVolt < 5.0f || !jkbms.dataValid) {
    errorString = "BAT WIRE FAULT"; 
  }

  if (nowMs - statusToggleTime >= 3000UL) {
    statusPage = (statusPage + 1) % 3;
    statusToggleTime = nowMs;
  }

  // ---------------------------------------------------------
  // ⏳ SMART TIMER LOGIC (UNSIGNED MILLIS SAFE)
  // ---------------------------------------------------------
  bool shouldRunGridReturnTimer = false;
  if (isGrid && inverterState) {
    if (pcutMode || ecoMode) {
      shouldRunGridReturnTimer = true; 
    }
  }

  if (shouldRunGridReturnTimer) {
    if (!gridReturnTimerActive) {
      gridReturnTime = nowMs;
      gridReturnTimerActive = true;
    }
  } else {
    gridReturnTimerActive = false;
    gridReturnTime = 0;
  }

  // Power-cut timer: runs in PCUT and ECO+PCUT mode only when inverter is OFF and battery has enough voltage (>= 12.5V) to start
  if (!isGrid && !inverterState && pcutMode && (batVolt >= 12.5f)) {
    if (!powerCutTimerActive) {
      powerCutTime = nowMs;
      powerCutTimerActive = true;
    }
  } else {
    powerCutTimerActive = false;
    powerCutTime = 0; 
  }

  int countdownSecs = -1;
  const char* countdownType = "";

  if (gridReturnTimerActive) {
    unsigned long elapsedSec = (nowMs - gridReturnTime) / 1000UL;
    if (elapsedSec < (unsigned long)TIMER_DELAY_SEC) {
      countdownSecs = TIMER_DELAY_SEC - (int)elapsedSec;
      countdownType = "GRID_RET";
    } else {
      countdownSecs = 0;
      countdownType = "GRID_RET";
    }
  }
  else if (powerCutTimerActive) {
    unsigned long elapsedSec = (nowMs - powerCutTime) / 1000UL;
    if (elapsedSec < (unsigned long)TIMER_DELAY_SEC) {
      countdownSecs = TIMER_DELAY_SEC - (int)elapsedSec;
      countdownType = "PWR_CUT";
    } else {
      countdownSecs = 0;
      countdownType = "PWR_CUT";
    }
  }

  // ---------------------------------------------------------
  // CORE AUTOMATION LOGIC 
  // ---------------------------------------------------------
  if (errorString[0] != '\0') {
    modeString = "ERROR";
    inverterState = false;
    smpsState = false;
    gridReturnTimerActive = false;
    powerCutTimerActive = false;
    countdownSecs = -1;
  }
  else if (manualMode) {
    modeString = "MANUAL";
    inverterState = manualInverterOverride;
    smpsState = manualSmpsOverride;
    gridReturnTimerActive = false;
    powerCutTimerActive = false;
    countdownSecs = -1;
  }
  else if (ecoMode && pcutMode) {
    modeString = "ECO+POWER CUT"; 
    
    if (!isGrid) {
      if (inverterState) {
        if (batVolt <= 12.0f) inverterState = false;
      } else {
        if (powerCutTimerActive && (nowMs - powerCutTime >= TIMER_DELAY_MS) && batVolt >= 12.5f) {
          inverterState = true;
          powerCutTimerActive = false;
          powerCutTime = 0;
          countdownSecs = -1;
        }
        if (batVolt <= 12.0f) inverterState = false;
      }
    } else {
      if (gridReturnTimerActive && (nowMs - gridReturnTime >= TIMER_DELAY_MS)) {
        inverterState = false;
        gridReturnTimerActive = false;
        gridReturnTime = 0;
        countdownSecs = -1;
      }
    }
  } 
  else if (ecoMode) {
    modeString = "ECO MODE";
    inverterState = false;
    gridReturnTimerActive = false;
    powerCutTimerActive = false;
    countdownSecs = -1;
  } 
  else if (pcutMode) {
    modeString = "POWER CUT"; 
    if (!isGrid) {
      if (powerCutTimerActive && (nowMs - powerCutTime >= TIMER_DELAY_MS) && batVolt >= 12.5f) {
        inverterState = true;
        powerCutTimerActive = false;
        powerCutTime = 0;
        countdownSecs = -1;
      }
      if (batVolt <= 12.0f) inverterState = false; 
    } else {
      if (gridReturnTimerActive && (nowMs - gridReturnTime >= TIMER_DELAY_MS)) {
        inverterState = false; 
        gridReturnTimerActive = false;
        gridReturnTime = 0;
        countdownSecs = -1;
      }
    }
  } 
  else {
    modeString = "POWER OFF";
    inverterState = false;
    gridReturnTimerActive = false;
    powerCutTimerActive = false;
    countdownSecs = -1;
  }

  activeCountdownSecs = countdownSecs;

  // ---------------------------------------------------------
  // ⚡ SMPS EXTRA CHARGER LOGIC (STRICT INVERTER-OFF INTERLOCK IN ALL MODES)
  // ---------------------------------------------------------
  // Automatic charging is allowed in ANY non-manual mode ONLY when Inverter is OFF and no battery fault exists
  bool allowAutoCharging = (errorString[0] == '\0') && !inverterState && !manualMode;

  // Reset top-up Done flags when we are outside the respective time windows
  if (currentHour != 17) {
    topup530Done = false;
  }
  if (currentHour != 1) {
    topup1amDone = false;
  }

  // Strict Hardware Interlock: if Inverter is ON, fault exists, or battery reached 15.5V stop threshold, cut off charging
  if (inverterState || errorString[0] != '\0' || batVolt >= BAT_CHARGE_STOP_THRESHOLD) {
    forceChargingActive = false;
    manualSmpsOverride = false;
  }

  // --- Flatline Detection Logic (Runs for all active charging requests while Inverter is OFF) ---
  bool anyChargingRequest = !inverterState && (errorString[0] == '\0') && (
    forceChargingActive || (manualMode && manualSmpsOverride) || topup530Active || topup1amActive || normalChargingActive
  );
  if (anyChargingRequest) {
    if (batVolt >= DVDT_START_VOLTAGE) {
      if (lastRecordedVoltage == 0.0f) {
        lastRecordedVoltage = batVolt;
        lastVoltageCheckTime = nowMs;
        flatlineDetected = false;
      } else {
        if (nowMs - lastVoltageCheckTime >= VOLTAGE_CHECK_INTERVAL) {
          if (batVolt <= lastRecordedVoltage) {
            flatlineDetected = true; 
          }
          lastRecordedVoltage = batVolt;
          lastVoltageCheckTime = nowMs;
        }
      }
    } else {
      lastRecordedVoltage = 0.0f;
      flatlineDetected = false;
    }
  } else {
    lastRecordedVoltage = 0.0f;
    flatlineDetected = false;
  }

  if (inverterState || errorString[0] != '\0') {
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

  setCurrentModeSafe(modeString);

  // Wake MQTT immediately on any relay or grid transition even during 15-min idle sleep
  // Also schedule an I2C/OLED self-heal 400ms after any relay switches to clear contactor EMI spikes!
  static bool prevPublishedInv = false;
  static bool prevPublishedSmps = false;
  static bool prevPublishedGrid = false;
  static bool transitionTrackInit = false;
  static bool pendingOledEmiRecover = false;
  static unsigned long relaySwitchTimestamp = 0;

  if (!transitionTrackInit) {
    prevPublishedInv = inverterState;
    prevPublishedSmps = smpsState;
    prevPublishedGrid = isGrid;
    transitionTrackInit = true;
  } else {
    if (prevPublishedInv != inverterState || prevPublishedSmps != smpsState) {
      pendingOledEmiRecover = true;
      relaySwitchTimestamp = nowMs;
    }
    if (prevPublishedInv != inverterState || prevPublishedSmps != smpsState || prevPublishedGrid != isGrid) {
      prevPublishedInv = inverterState;
      prevPublishedSmps = smpsState;
      prevPublishedGrid = isGrid;
      forceImmediatePublish = true;
      forceOfflineSnapshot = true;
    }
  }

  // Re-verify I2C bus & SSD1306 OLED controller 400ms after any relay switching event (or every 30s)
  static unsigned long lastPeriodicOledCheck = 0;
  if (pendingOledEmiRecover && (nowMs - relaySwitchTimestamp >= 400UL)) {
    pendingOledEmiRecover = false;
    if (digitalRead(I2C_SDA_PIN) == LOW) {
      recoverI2CBus(true);
    } else if (oledFound) {
      Wire.beginTransmission(0x3C);
      if (Wire.endTransmission() != 0) {
        recoverI2CBus(true);
      } else {
        display.ssd1306_command(SSD1306_DISPLAYON);
        display.ssd1306_command(SSD1306_NORMALDISPLAY);
      }
    }
  } else if (nowMs - lastPeriodicOledCheck >= 30000UL) {
    lastPeriodicOledCheck = nowMs;
    if (digitalRead(I2C_SDA_PIN) == LOW) {
      recoverI2CBus(true);
    } else if (oledFound) {
      Wire.beginTransmission(0x3C);
      if (Wire.endTransmission() != 0) {
        recoverI2CBus(true);
      }
    }
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
    if (strcmp(errorString, "BAT WIRE FAULT") == 0) {
      display.print(F("--.-V"));
    } else {
      display.print(batVolt, 1);
      display.print(F("V"));
    }

    display.setCursor(95, 1);
    display.print(displayTimeBuf);
    
    display.drawFastHLine(0, 11, 128, SSD1306_WHITE);

    display.setCursor(0, 20);
    if (otaInProgress) {
      display.setTextSize(2);
      display.print(F("OTA UPDATE"));
    }
    else if (countdownSecs >= 0) {
      display.setTextSize(2); 
      display.print(countdownSecs);
      display.print(F("s WAIT"));
    } 
    else {
      if (strcmp(modeString, "ECO+POWER CUT") == 0) {
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
    
    if (otaInProgress) {
      display.print(F("Flashing via Wi-Fi..."));
    }
    else if (strcmp(modeString, "ERROR") == 0) {
      display.print(F("Fault: "));
      display.print(errorString);
    } 
    else if (countdownSecs >= 0) {
      if (strcmp(countdownType, "PWR_CUT") == 0) {
        display.print(F("Grid DOWN -> INV ON"));
      } else if (strcmp(countdownType, "GRID_RET") == 0) {
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
        if (solVolt > 5.0f) {
          display.print(solVolt, 1);
          display.print(F("V"));
        } else {
          display.print(F("NO"));
        }
      } 
      else if (statusPage == 2) {
        display.print(F("Status: "));
        if (strcmp(modeString, "POWER OFF") == 0) display.print(F("SYSTEM SHUTDOWN"));
        else if (strcmp(modeString, "MANUAL") == 0) display.print(F("MANUAL OVERRIDE"));
        else if (!isGrid && batVolt <= 12.0f) display.print(F("BATTERY CUTOFF"));
        else if (!isGrid && !inverterState && batVolt < 12.5f) display.print(F("LOW BAT (<12.5V)"));
        else display.print(F("SYSTEM NORMAL"));
      }
    }

    display.display();
  }
  delay(200); 
}
