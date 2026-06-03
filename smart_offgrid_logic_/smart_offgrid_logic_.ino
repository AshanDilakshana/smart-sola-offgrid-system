#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFi.h>          
#include <WiFiUdp.h>
#include <NTPClient.h>
#include <RTClib.h>        // Adafruit RTClib ලයිබ්‍රරි එක

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

// NTP Time Client Settings (Sri Lanka Time Zone: UTC +5:30)
WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "pool.ntp.org", 19800, 60000);

// ---------------------------------------------------------
// ESP32 PIN Definitions
// ---------------------------------------------------------
const int BATTERY_PIN = 34;   
const int INV_RELAY   = 25;   
const int SMPS_RELAY  = 26;   

const int SOLAR_SENS  = 32;   
const int GRID_SENS   = 33;   

const int ECO_SWITCH    = 14; 
const int PCUT_SWITCH   = 27; 
const int MANUAL_SWITCH = 13; 

// Voltage Divider Calibration
const float R1 = 100000.0; 
const float R2 = 10000.0;  
const float V_REF = 3.21;   

// --- Easy Timer Configuration ---
const unsigned long TIMER_DELAY_MS = 10000; 
const int TIMER_DELAY_SEC = 10;

// Timer, Toggle & State Variables
unsigned long powerCutTime = 0;
unsigned long gridReturnTime = 0;
unsigned long statusToggleTime = 0;
bool powerCutTimerActive = false;
bool gridReturnTimerActive = false;
bool inverterState = false;
bool smpsState = false;
int statusPage = 0; 

void setup() {
  Serial.begin(115200);

  // ESP32 ADC Resolution settings
  analogSetAttenuation(ADC_11db);

  // Active-Low Relay Boot Glitch Fix
  digitalWrite(INV_RELAY, HIGH);
  digitalWrite(SMPS_RELAY, HIGH);
  pinMode(INV_RELAY, OUTPUT);
  pinMode(SMPS_RELAY, OUTPUT);

  // Sensing and Switch Pins
  pinMode(SOLAR_SENS, INPUT);
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
    Serial.println("RTC සොයාගත නොහැකි විය!");
  }

  // Connect to WiFi
  WiFi.begin(ssid, password);
  
  // Start NTP Client
  timeClient.begin();
}

float getBatteryVoltage() {
  int raw = analogRead(BATTERY_PIN);
  float v_out = (raw * V_REF) / 4095.0; 
  float v_bat = v_out * ((R1 + R2) / R2);
  return v_bat;
}

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

void loop() {
  String displayTime = "--:--";

  // --- SMART TIME LOGIC (NTP vs RTC Fallback) ---
  if (WiFi.status() == WL_CONNECTED) {
    timeClient.update();
    displayTime = timeClient.getFormattedTime().substring(0, 5);
    
    // ඉන්ටර්නෙට් ඇති විට වෙලාව RTC මොඩියුලයට දමා Sync කරයි
    rtc.adjust(DateTime(timeClient.getEpochTime()));
  } else {
    // ඉන්ටර්නෙට් නැති විට RTC එකෙන් වෙලාව ලබා ගනී
    DateTime now = rtc.now();
    char buf[] = "hh:mm";
    displayTime = String(now.toString(buf));
  }

  float batVolt = getBatteryVoltage();
  bool isSolar = digitalRead(SOLAR_SENS);
  bool isGrid = digitalRead(GRID_SENS);
  
  // Active-LOW State Reading
  bool manualMode = (digitalRead(MANUAL_SWITCH) == LOW); 
  bool ecoMode   = manualMode ? false : (digitalRead(ECO_SWITCH) == LOW);
  bool pcutMode  = manualMode ? false : (digitalRead(PCUT_SWITCH) == LOW); 
  
  String modeString = "POWER OFF"; 
  String errorString = ""; 

  if (batVolt < 5.0) {
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
    if (pcutMode && !ecoMode) {
      shouldRunGridReturnTimer = true; 
    }
    else if (ecoMode && pcutMode) {
      if (batVolt <= 14.2 || !isSolar) {
        shouldRunGridReturnTimer = true;
      }
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

  if (!isGrid && !inverterState && pcutMode) {
    if (!powerCutTimerActive) {
      powerCutTime = millis();
      powerCutTimerActive = true;
    }
  } else {
    powerCutTimerActive = false;
    powerCutTime = 0; 
  }

  // ---------------------------------------------------------
  // CALCULATE DISPLAY COUNTDOWN SECONDS
  // ---------------------------------------------------------
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
    inverterState = false;
    smpsState = false;
  }
  else if (ecoMode && pcutMode) {
    modeString = "ECO+POWER CUT"; 
    
    if (!isGrid) {
      if (inverterState) {
        if (batVolt <= 12.0) inverterState = false; 
      } else {
        if (powerCutTimerActive && (millis() - powerCutTime >= TIMER_DELAY_MS) && batVolt > 12.0) {
          inverterState = true;
        }
      }
    } else {
      if (isSolar && batVolt >= 15.4) inverterState = true;
      
      if (batVolt <= 14.2 || (!isSolar && inverterState)) {
        if (gridReturnTimerActive) {
          if (millis() - gridReturnTime >= TIMER_DELAY_MS) inverterState = false;
        } else {
          inverterState = false;
        }
      }
    }
  } 
  else if (ecoMode) {
    modeString = "ECO MODE";
    if (isSolar) {
      if (batVolt >= 15.4) inverterState = true;
      if (batVolt <= 14.2) inverterState = false;
    } else {
      inverterState = false; 
    }
  } 
  else if (pcutMode) {
    modeString = "POWER CUT"; 
    if (!isGrid) {
      if (powerCutTimerActive && (millis() - powerCutTime >= TIMER_DELAY_MS) && batVolt > 12.0) {
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

  // SMPS EXTRA CHARGER LOGIC
  bool allowCharging = (errorString == "") && isGrid && !inverterState && (ecoMode || pcutMode || modeString == "POWER OFF");

  if (allowCharging) {
    if (batVolt >= 12.0 && batVolt <= 12.5) {
      smpsState = true; 
    }
    if (batVolt >= 13.8) {
      smpsState = false; 
    }
  } else {
    smpsState = false; 
  }

  // Execute Relay Actions
  digitalWrite(INV_RELAY, inverterState ? LOW : HIGH);
  digitalWrite(SMPS_RELAY, smpsState ? LOW : HIGH);

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

  // මෙතනට ලයිව් වෙලාව (NTP හෝ RTC එකෙන් එන) වැටේ
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
      display.print(isSolar ? F("YES") : F("NO"));
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