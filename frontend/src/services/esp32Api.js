// ESP32 API Service — Hosted Node.js Backend (MQTT + MongoDB + SSE Stream) & Local LAN Offline Fallback

const DEFAULT_BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'https://smart-sola-offgrid-system.onrender.com';

export function getBackendUrl() {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('smart_offgrid_backend_url');
    if (saved && saved.trim()) return saved.trim().replace(/\/+$/, '');
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
const cloudEventListeners = new Set();

export function subscribeCloudEvents(listener) {
  cloudEventListeners.add(listener);
  return () => {
    cloudEventListeners.delete(listener);
  };
}

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

    sseSource.addEventListener('event', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data && data.event) {
          for (const listener of cloudEventListeners) {
            try {
              listener(data);
            } catch (_) {}
          }
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
  // Send renewal heartbeat at ~65s (right before ESP32's 90s active live-stream window sleeps)
  if (now - lastHeartbeatSent < 65000) return;
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchHistory(connectionMode, days = 7, maxPoints = 480) {
  if (connectionMode !== 'cloud') return [];
  try {
    const res = await fetchWithTimeout(
      `${getBackendUrl()}/api/history?days=${days}&maxPoints=${maxPoints}`,
      {},
      8000
    );
    if (res.ok) {
      const data = await res.json();
      return Array.isArray(data) ? data.sort((a, b) => a.epoch - b.epoch) : [];
    }
  } catch (err) {
    console.warn('MongoDB Backend history fetch failed:', err.message);
  }
  return [];
}

function computeClientDailyUptime(rows, days = 7) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => a.epoch - b.epoch);
  const dailyMap = new Map();
  let inDeepDischarge = false;

  for (let i = 0; i < sorted.length; i++) {
    const curr = sorted[i];
    const dateObj = new Date(curr.epoch * 1000);
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    const dateKey = `${y}-${m}-${d}`;
    const dateStr = dateObj.toLocaleDateString();
    const shortDay = dateObj.toLocaleDateString('en-US', { weekday: 'short' });

    if (!dailyMap.has(dateKey)) {
      dailyMap.set(dateKey, {
        dateKey,
        dateStr,
        shortDay,
        uptimeSec: 0,
        deepDischargeCount: 0,
        minVoltage: Number(curr.batteryVoltage),
        maxVoltage: Number(curr.batteryVoltage)
      });
    }

    const bucket = dailyMap.get(dateKey);
    const v = Number(curr.batteryVoltage ?? 0);
    if (v > 1) {
      bucket.minVoltage = Math.min(bucket.minVoltage, v);
      bucket.maxVoltage = Math.max(bucket.maxVoltage, v);
    }

    const dtSec = i < sorted.length - 1
      ? Math.min(Math.max(Number(sorted[i + 1].epoch) - Number(curr.epoch), 0), 30 * 60)
      : (curr.inverterState || curr.phase === 'discharging' ? 120 : 900);

    if (curr.inverterState) {
      bucket.uptimeSec += dtSec;
    }

    const isDeep = Boolean(curr.inverterState)
      && (curr.mode === 'MANUAL' || curr.modeString === 'MANUAL')
      && v > 1
      && v <= 12.5;
    if (isDeep && !inDeepDischarge) {
      bucket.deepDischargeCount += 1;
    }
    inDeepDischarge = isDeep;
  }

  return Array.from(dailyMap.values())
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
    .slice(-days)
    .map(({ uptimeSec, minVoltage, maxVoltage, ...rest }) => ({
      ...rest,
      uptimeHours: Number((uptimeSec / 3600).toFixed(2)),
      minVoltage: Number.isFinite(minVoltage) ? Number(minVoltage.toFixed(2)) : null,
      maxVoltage: Number.isFinite(maxVoltage) ? Number(maxVoltage.toFixed(2)) : null
    }));
}

export async function fetchDailyUptime(connectionMode = 'cloud', days = 7) {
  if (connectionMode !== 'cloud') return [];
  const tzOffsetMin = new Date().getTimezoneOffset();
  try {
    const res = await fetchWithTimeout(
      `${getBackendUrl()}/api/history/daily?days=${days}&tzOffsetMin=${tzOffsetMin}`,
      {},
      8000
    );
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) return data;
    }
    // Fallback if hosted server hasn't deployed /api/history/daily yet
    const rows = await fetchHistory(connectionMode, days, 2000);
    return computeClientDailyUptime(rows, days);
  } catch (err) {
    console.warn('MongoDB Backend daily uptime fetch failed:', err.message);
    return [];
  }
}

export async function fetchCloudEvents(connectionMode = 'cloud', limit = 150) {
  if (connectionMode !== 'cloud') return [];
  try {
    const res = await fetchWithTimeout(
      `${getBackendUrl()}/api/events?days=60&limit=${limit}`,
      {},
      8000
    );
    if (res.ok) {
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    }
  } catch (err) {}
  return [];
}

export async function saveCloudEvent(connectionMode = 'cloud', eventText, type = 'info', details = {}) {
  if (connectionMode !== 'cloud' || !eventText) return;
  try {
    await fetchWithTimeout(
      `${getBackendUrl()}/api/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: eventText, type, details })
      },
      5000
    );
  } catch (err) {}
}

export const GITHUB_RAW_MAIN_BASE = 'https://raw.githubusercontent.com/AshanDilakshana/smart-sola-offgrid-system/main';
export const GITHUB_OTA_BINARY_URL = `${GITHUB_RAW_MAIN_BASE}/smart_offgrid_logic_/build/smart_offgrid_logic_.ino.bin`;

export function parseVersionTuple(verStr) {
  if (!verStr || typeof verStr !== 'string') return [0, 0, 0];
  const cleaned = verStr.trim().replace(/^v/i, '');
  const parts = cleaned.split('.').map((n) => parseInt(n, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export function isNewerFirmwareVersion(installedVer, remoteVer) {
  if (!installedVer || !remoteVer) return false;
  const a = parseVersionTuple(installedVer);
  const b = parseVersionTuple(remoteVer);
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

export async function fetchLatestGithubFirmware() {
  const bust = Date.now();
  // 1. Check compiled build manifest (version.json committed by GitHub Actions after .bin build)
  try {
    const res = await fetchWithTimeout(
      `${GITHUB_RAW_MAIN_BASE}/smart_offgrid_logic_/build/version.json?t=${bust}`,
      { cache: 'no-store' },
      6000
    );
    if (res.ok) {
      const meta = await res.json();
      if (meta && typeof meta.version === 'string' && meta.version.trim()) {
        return {
          version: meta.version.trim(),
          builtAt: meta.builtAt || null,
          binaryUrl: `${GITHUB_RAW_MAIN_BASE}/${meta.binaryPath || 'smart_offgrid_logic_/build/smart_offgrid_logic_.ino.bin'}`,
          source: 'build-manifest'
        };
      }
    }
  } catch (_) {}

  // 2. Fallback: parse FIRMWARE_VERSION directly from main branch .ino source
  try {
    const res = await fetchWithTimeout(
      `${GITHUB_RAW_MAIN_BASE}/smart_offgrid_logic_/smart_offgrid_logic_.ino?t=${bust}`,
      { cache: 'no-store' },
      6000
    );
    if (res.ok) {
      const text = await res.text();
      const match = text.match(/FIRMWARE_VERSION\s*=\s*"([^"]+)"/);
      if (match && match[1]) {
        return {
          version: match[1].trim(),
          builtAt: null,
          binaryUrl: GITHUB_OTA_BINARY_URL,
          source: 'ino-source'
        };
      }
    }
  } catch (_) {}

  return null;
}

