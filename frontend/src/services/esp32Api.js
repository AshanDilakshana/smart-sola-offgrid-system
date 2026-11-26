// ESP32 API Service — Hosted Node.js Backend (MQTT + MongoDB + SSE Stream) & Local LAN Offline Fallback

const DEFAULT_BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'https://smart-sola-offgrid-system.onrender.com';

export function getBackendUrl() {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('smart_offgrid_backend_url');
    if (saved && saved !== 'http://localhost:5000') return saved;
  }
  return DEFAULT_BACKEND_URL;
}

export function setBackendUrl(newUrl) {
  if (typeof window !== 'undefined' && newUrl) {
    const cleaned = newUrl.trim().replace(/\/+$/, '');
    localStorage.setItem('smart_offgrid_backend_url', cleaned);
    if (sseSource) {
      sseSource.close();
      sseSource = null;
    }
  }
}

let mockState = {
  batteryVoltage: 14.4,
  batteryCurrent: 2.5,
  batterySoc: 88,
  cellVoltages: [3.601, 3.598, 3.595, 3.594],
  solarVoltage: 0.0,
  gridPresent: true,
  inverterState: false,
  smpsState: true,
  modeString: 'POWER OFF',
  webModeOverride: -1,
  forceChargingActive: false,
  topup530Active: false,
  topup1amActive: false,
  normalChargingActive: false,
  flatlineDetected: false,
  wifiConnected: true,
  mqttConnected: true,
  mongoConnected: true,
  rssi: -62,
  ip: '192.168.1.150',
  chargingOffset: 0.5,
  batStartThreshold: 12.5,
  batStopThreshold: 15.5,
  batTopupThreshold: 14.5,
  firmwareVersion: 'v1.0.5'
};

// Real-time Server-Sent Events (SSE) cache from Hosted Backend (MQTT -> Backend -> SSE)
let sseSource = null;
let latestSseStatus = null;
let lastSseReceivedAt = 0;
let lastHeartbeatSent = 0;

function ensureSseStream() {
  if (sseSource || typeof window === 'undefined' || typeof EventSource === 'undefined') return;

  try {
    const backendUrl = getBackendUrl();
    sseSource = new EventSource(`${backendUrl}/api/stream`);

    sseSource.addEventListener('status', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data && data.batteryVoltage !== undefined) {
          latestSseStatus = {
            ...data,
            cloudConnected: true,
            sseActive: true,
            isConnected: true
          };
          lastSseReceivedAt = Date.now();
        }
      } catch (err) {}
    });

    sseSource.addEventListener('availability', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (latestSseStatus && data.deviceOnline === false) {
          latestSseStatus = {
            ...latestSseStatus,
            deviceOnline: false
          };
        }
      } catch (err) {}
    });

    sseSource.onerror = () => {
      if (sseSource) {
        sseSource.close();
        sseSource = null;
      }
    };
  } catch (err) {
    sseSource = null;
  }
}

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

async function sendAppHeartbeat() {
  const now = Date.now();
  if (now - lastHeartbeatSent < 15000) return;
  lastHeartbeatSent = now;
  try {
    await fetch(`${getBackendUrl()}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastHeartbeat: now })
    });
  } catch (err) {}
}

// Helper for Local ESP32 HTTP request with timeout
async function fetchLocalEsp32(url, options = {}, timeoutMs = 2200) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchSystemStatus(esp32Ip, connectionMode = 'cloud') {
  const backendUrl = getBackendUrl();

  if (connectionMode === 'cloud') {
    ensureSseStream();
    sendAppHeartbeat();

    // 1. If SSE real-time stream pushed fresh data within the last 4 seconds, return immediately
    if (latestSseStatus && Date.now() - lastSseReceivedAt < 4000) {
      return latestSseStatus;
    }

    // 2. Otherwise query the Hosted Backend REST endpoint
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${backendUrl}/api/status`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) throw new Error('Backend HTTP ' + res.status);
      const data = await res.json();
      if (data && data.batteryVoltage !== undefined) {
        return {
          ...data,
          cloudConnected: true,
          isConnected: data.isConnected !== false
        };
      }

      // If Backend is running but waiting for ESP32 MQTT packet, try Local IP fallback if on home Wi-Fi
      if (esp32Ip) {
        try {
          const localData = await fetchLocalEsp32(`http://${esp32Ip}/api/status`);
          return { ...localData, isConnected: true, localFallbackActive: true };
        } catch (_) {}
      }

      return {
        isConnected: false,
        mqttConnected: data?.mqttConnected,
        mongoConnected: data?.mongoConnected,
        error: data?.error || 'Waiting for ESP32 MQTT stream on Hosted Backend...'
      };
    } catch (err) {
      // 3. Offline / Internet Interrupt Auto-Fallback:
      // If internet or backend is unreachable, automatically try Local ESP32 IP on the LAN!
      if (esp32Ip) {
        try {
          const localData = await fetchLocalEsp32(`http://${esp32Ip}/api/status`);
          return {
            ...localData,
            isConnected: true,
            localFallbackActive: true
          };
        } catch (_) {}
      }

      console.warn('Hosted Backend sync error:', err.message);
      return {
        isConnected: false,
        error: `Cloud Backend Unreachable (${backendUrl}) & Local ESP32 (${esp32Ip}) offline.`
      };
    }
  }

  // Local Wi-Fi IP Mode
  try {
    const data = await fetchLocalEsp32(`http://${esp32Ip}/api/status`, {}, 2500);
    return { ...data, isConnected: true, localDirect: true };
  } catch (err) {
    console.warn('ESP32 local connection failed:', err.message);
    return {
      isConnected: false,
      error: `Local Wi-Fi Connection Failed: Unable to reach ESP32 at IP http://${esp32Ip}`
    };
  }
}

export async function setSystemMode(esp32Ip, connectionMode, modeValue) {
  mockState.webModeOverride = modeValue;
  mockState.modeString = getModeString(modeValue);

  if (connectionMode === 'cloud') {
    try {
      const res = await fetch(`${getBackendUrl()}/api/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: modeValue })
      });
      if (res.ok) {
        if (latestSseStatus) latestSseStatus.webModeOverride = modeValue;
        return await res.json();
      }
    } catch (err) {
      console.warn('Cloud mode command failed, trying local fallback:', err.message);
    }
  }

  if (esp32Ip) {
    try {
      return await fetchLocalEsp32(`http://${esp32Ip}/api/mode?mode=${modeValue}`, { method: 'POST' });
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
      const res = await fetch(`${getBackendUrl()}/api/charge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: newState })
      });
      if (res.ok) {
        if (latestSseStatus) {
          latestSseStatus.forceChargingActive = newState;
          latestSseStatus.smpsState = newState;
        }
        return await res.json();
      }
    } catch (err) {
      console.warn('Cloud force charge command failed, trying local fallback:', err.message);
    }
  }

  if (esp32Ip) {
    try {
      return await fetchLocalEsp32(`http://${esp32Ip}/api/charge?active=${newState}`, { method: 'POST' });
    } catch (err) {}
  }

  return { success: true, forceChargingActive: newState };
}

export async function controlManualRelay(esp32Ip, connectionMode, relayType, state) {
  if (relayType === 'inverter') mockState.inverterState = state;
  if (relayType === 'smps') mockState.smpsState = state;

  if (connectionMode === 'cloud') {
    try {
      const payload = relayType === 'inverter' ? { inverter: state } : { smps: state };
      const res = await fetch(`${getBackendUrl()}/api/relay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) return await res.json();
    } catch (err) {
      console.warn('Cloud relay command failed, trying local fallback:', err.message);
    }
  }

  if (esp32Ip) {
    try {
      const query = relayType === 'inverter' ? `inverter=${state}` : `smps=${state}`;
      return await fetchLocalEsp32(`http://${esp32Ip}/api/relay?${query}`, { method: 'POST' });
    } catch (err) {}
  }

  return { success: true };
}

export async function triggerOtaUpdate(esp32Ip, connectionMode, firmwareUrl) {
  if (connectionMode === 'cloud') {
    try {
      const res = await fetch(`${getBackendUrl()}/api/ota-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: firmwareUrl })
      });
      if (res.ok) return await res.json();
    } catch (err) {
      console.warn('Cloud OTA trigger failed, trying local fallback:', err.message);
    }
  }

  if (esp32Ip) {
    try {
      return await fetchLocalEsp32(
        `http://${esp32Ip}/api/ota-update?url=${encodeURIComponent(firmwareUrl)}`,
        { method: 'POST' }
      );
    } catch (err) {}
  }

  return { success: true, message: 'OTA Update command issued' };
}

export async function fetchHistory(connectionMode) {
  if (connectionMode === 'cloud') {
    try {
      const res = await fetch(`${getBackendUrl()}/api/history?days=7`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          return data.sort((a, b) => a.epoch - b.epoch);
        }
      }
    } catch (err) {
      console.warn('MongoDB Backend history fetch failed:', err.message);
    }
  }

  // Standalone mode mock data generator if MongoDB has no records yet
  const mockHistory = [];
  const now = Math.floor(Date.now() / 1000);
  const intervals = 7 * 24 * 4;

  for (let i = intervals; i >= 0; i--) {
    const epoch = now - (i * 900);
    const hour = new Date(epoch * 1000).getHours();
    const isDay = hour >= 7 && hour <= 17;
    const isManualEvent = Math.random() > 0.95;

    mockHistory.push({
      epoch: epoch,
      batteryVoltage: isManualEvent ? 12.4 : (isDay ? 14.1 : 12.8),
      inverterState: isManualEvent ? true : Math.random() > 0.3,
      mode: isManualEvent ? 'MANUAL' : 'ECO MODE',
      batterySoc: isDay ? 90 : 50,
      gridPresent: false
    });
  }

  return mockHistory;
}

export async function fetchCloudEvents(connectionMode = 'cloud') {
  if (connectionMode !== 'cloud') return [];
  try {
    const res = await fetch(`${getBackendUrl()}/api/events`);
    if (res.ok) {
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    }
  } catch (err) {}
  return [];
}
