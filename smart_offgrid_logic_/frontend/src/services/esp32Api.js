// ESP32 API Service, Global Firebase Cloud Sync & Live Mock Simulator

const FIREBASE_DB_URL = "https://my-smart-off-grid-default-rtdb.firebaseio.com";

let mockState = {
  batteryVoltage: 13.4,
  solarVoltage: 0.0,
  gridPresent: true,
  inverterState: false,
  smpsState: false,
  modeString: 'POWER OFF',
  webModeOverride: -1,
  forceChargingActive: false,
  topup530Active: false,
  topup1amActive: false,
  normalChargingActive: false,
  flatlineDetected: false,
  wifiConnected: true,
  rssi: -62,
  ip: '192.168.1.150',
  chargingOffset: 0.5,
  batStartThreshold: 12.5,
  batStopThreshold: 15.5,
  batTopupThreshold: 14.5,
  firmwareVersion: 'v1.0.1'
};

// Internal simulation ticker for standalone offline testing
setInterval(() => {
  if (mockState.smpsState || mockState.forceChargingActive) {
    mockState.batteryVoltage = Math.min(15.5, +(mockState.batteryVoltage + 0.05).toFixed(2));
    if (mockState.batteryVoltage >= 15.5) {
      mockState.forceChargingActive = false;
      mockState.normalChargingActive = false;
      mockState.topup530Active = false;
      mockState.topup1amActive = false;
      mockState.smpsState = false;
      mockState.modeString = getModeString(mockState.webModeOverride);
    }
  } else if (mockState.inverterState) {
    mockState.batteryVoltage = Math.max(11.8, +(mockState.batteryVoltage - 0.03).toFixed(2));
  }
}, 3000);

function getModeString(override) {
  switch (override) {
    case 0: return 'POWER OFF';
    case 1: return 'ECO MODE';
    case 2: return 'POWER CUT';
    case 3: return 'ECO+POWER CUT';
    case 4: return 'MANUAL';
    default: return 'POWER OFF';
  }
}

let lastHeartbeatSent = 0;

async function sendAppHeartbeat() {
  const now = Date.now();
  if (now - lastHeartbeatSent < 10000) return; // Send heartbeat ping every 10s
  lastHeartbeatSent = now;
  try {
    await fetch(`${FIREBASE_DB_URL}/commands.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastHeartbeat: now })
    });
  } catch (err) {}
}

export async function fetchSystemStatus(esp32Ip, connectionMode = 'cloud') {
  if (connectionMode === 'cloud') {
    // Send active session heartbeat ping to wake up ESP32 live sync
    sendAppHeartbeat();

    try {
      const res = await fetch(`${FIREBASE_DB_URL}/status.json`);
      if (!res.ok) throw new Error('Firebase HTTP ' + res.status);
      const data = await res.json();
      if (data && data.batteryVoltage !== undefined) {
        return { ...data, cloudConnected: true, isConnected: true };
      }
      return { isConnected: false, error: 'No status data found on Firebase Cloud Database.' };
    } catch (err) {
      console.warn('Firebase Cloud sync error:', err.message);
      return { isConnected: false, error: 'Cloud Connection Failed: Unable to connect to Firebase.' };
    }
  }

  // Local Wi-Fi IP Mode
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);

    const res = await fetch(`http://${esp32Ip}/api/status`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error('HTTP error ' + res.status);
    const data = await res.json();
    return { ...data, isConnected: true };
  } catch (err) {
    console.warn('ESP32 local connection failed:', err.message);
    return { isConnected: false, error: `Local Wi-Fi Connection Failed: Unable to reach ESP32 at IP http://${esp32Ip}` };
  }
}

export async function setSystemMode(esp32Ip, connectionMode, modeValue) {
  mockState.webModeOverride = modeValue;
  mockState.modeString = getModeString(modeValue);

  if (connectionMode === 'cloud') {
    try {
      await fetch(`${FIREBASE_DB_URL}/commands.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webModeOverride: modeValue })
      });
      return { success: true, webModeOverride: modeValue };
    } catch (err) {
      console.error('Firebase command failed:', err);
    }
  }

  if (connectionMode === 'local' && esp32Ip) {
    try {
      const res = await fetch(`http://${esp32Ip}/api/mode?mode=${modeValue}`, { method: 'POST' });
      return await res.json();
    } catch (err) {}
  }

  return { success: true, webModeOverride: modeValue };
}

export async function toggleForceCharging(esp32Ip, connectionMode, targetState) {
  const newState = targetState !== undefined ? targetState : !mockState.forceChargingActive;
  mockState.forceChargingActive = newState;
  mockState.smpsState = newState;
  mockState.modeString = newState ? 'FORCE CHG' : getModeString(mockState.webModeOverride);

  if (connectionMode === 'cloud') {
    try {
      await fetch(`${FIREBASE_DB_URL}/commands.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceChargingActive: newState })
      });
      return { success: true, forceChargingActive: newState };
    } catch (err) {
      console.error('Firebase force charge command failed:', err);
    }
  }

  if (connectionMode === 'local' && esp32Ip) {
    try {
      const res = await fetch(`http://${esp32Ip}/api/charge?active=${newState}`, { method: 'POST' });
      return await res.json();
    } catch (err) {}
  }

  return { success: true, forceChargingActive: newState };
}

export async function controlManualRelay(esp32Ip, connectionMode, relayType, state) {
  if (relayType === 'inverter') mockState.inverterState = state;
  if (relayType === 'smps') mockState.smpsState = state;

  if (connectionMode === 'local' && esp32Ip) {
    try {
      const query = relayType === 'inverter' ? `inverter=${state}` : `smps=${state}`;
      await fetch(`http://${esp32Ip}/api/relay?${query}`, { method: 'POST' });
    } catch (err) {}
  }

  return { success: true };
}

export async function triggerOtaUpdate(esp32Ip, connectionMode, firmwareUrl) {
  if (connectionMode === 'cloud') {
    try {
      await fetch(`${FIREBASE_DB_URL}/commands.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otaUrl: firmwareUrl })
      });
      return { success: true, message: 'OTA Update command sent to Cloud!' };
    } catch (err) {
      console.error('Firebase OTA trigger failed:', err);
    }
  }

  if (connectionMode === 'local' && esp32Ip) {
    try {
      const res = await fetch(`http://${esp32Ip}/api/ota-update?url=${encodeURIComponent(firmwareUrl)}`, { method: 'POST' });
      return await res.json();
    } catch (err) {}
  }

  return { success: true, message: 'OTA Update command issued (Mock)' };
}
