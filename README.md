# ☀️ Smart Solar Off-Grid System

![Version](https://img.shields.io/badge/version-v1.0.1-blue.svg)
![Platform](https://img.shields.io/badge/platform-ESP32-green.svg)
![License](https://img.shields.io/badge/license-MIT-yellow.svg)

An intelligent, IoT-enabled solar off-grid power management system. Built around the ESP32 microcontroller, this system dynamically routes power between Solar/Battery and the Main Grid based on battery health, time-of-day automation, and cloud-based user commands.

## ✨ Key Features

- **🌐 Global Cloud Connectivity:** Monitor and control your home's power from anywhere in the world using Firebase Realtime Database.
- **⚡ Smart Battery Management:** Automated 12V lead-acid / lithium battery charging routines, including scheduled top-up charges (5:30 PM & 1:00 AM) and intelligent dV/dt flatline detection.
- **📱 Modern Web Dashboard:** A highly responsive, glassmorphic UI built with React & Vite. Real-time animated gauges, power flows, and status indicators.
- **🧠 Dual-Core Processing:** Utilizes ESP32's FreeRTOS capabilities. Core 0 handles heavy HTTPS Firebase syncing while Core 1 smoothly runs the OLED display and millisecond-accurate physical switch debouncing.
- **🔌 3 Intelligent Modes:**
  - **ECO MODE:** Maximizes battery usage, dropping back to the grid only when the battery is critically low.
  - **POWER CUT MODE:** Acts as a heavy-duty UPS during grid failures.
  - **MANUAL OVERRIDE:** Complete manual control over Inverter and SMPS relays.
- **📡 Smart Data Saver (App Heartbeat):** The ESP32 intelligently pauses continuous cloud data uploads if the web dashboard is closed for more than 3 hours, saving Wi-Fi bandwidth and CPU cycles.
- **🔄 OTA Updates:** Seamless Over-The-Air firmware updates directly from GitHub Actions (CI/CD).

## 🛠️ Technology Stack

**Hardware / Firmware:**
- ESP32 (C++ / Arduino Core)
- FreeRTOS (Task Management)
- Adafruit SSD1306 OLED (I2C)
- Custom Voltage Divider Sensing

**Frontend (Web Dashboard):**
- React 18 + Vite
- Tailwind CSS (Custom Theme)
- Firebase JS SDK
- Framer Motion / CSS Animations

**Cloud Infrastructure:**
- Firebase Realtime Database

## ⚙️ System Architecture

1. **Physical Switches & Sensors:** Physical inputs (Eco, Pcut, Manual switches) and voltage sensors (ADC) feed into the ESP32.
2. **ESP32 Core Logic:** The system evaluates thresholds and activates the Inverter or SMPS Charger relays accordingly.
3. **FreeRTOS Firebase Task:** A background task securely syncs JSON telemetry to Firebase using `WiFiClientSecure` and `HTTPClient`, without blocking the main event loop.
4. **Web App:** The React application listens to Firebase real-time updates and presents a live, visually rich interface to the user.

## 🚀 Getting Started

### 1. ESP32 Firmware Setup
1. Open `smart_offgrid_logic_/smart_offgrid_logic_.ino` in the Arduino IDE (or PlatformIO).
2. Install required libraries: `Adafruit GFX`, `Adafruit SSD1306`, `RTClib`, `NTPClient`.
3. Update the `ssid` and `password` variables with your Wi-Fi credentials.
4. Flash to the ESP32 board.

### 2. Web Dashboard Setup
Navigate to the frontend directory and install dependencies:
```bash
cd smart_offgrid_logic_/frontend
npm install
npm run dev
```

### 3. Firebase Configuration
Ensure your Firebase Realtime database has the following structure initialized:
```json
{
  "commands": {
    "forceChargingActive": false,
    "webModeOverride": -1,
    "lastHeartbeat": 0
  },
  "status": {
    // ... telemetry data will be populated here by ESP32
  }
}
```

## 🛡️ Safety Mechanisms

- **Grid Debouncing:** Filters out noisy grid signals to prevent rapid relay switching.
- **Relay Boot Glitch Fix:** Active-low relays are forced HIGH during boot to prevent accidental triggering.
- **Hardware Watchdogs:** Built-in timers delay the grid return (180s) to stabilize voltage before reconnecting loads.

---
*Built with ❤️ for a sustainable future.*
