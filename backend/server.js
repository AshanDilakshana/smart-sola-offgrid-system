import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mqtt from 'mqtt';
import mongoose from 'mongoose';
import { HistoryLog } from './models/HistoryLog.js';
import { EventLog } from './models/EventLog.js';
import { SystemState } from './models/SystemState.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || '';
const AWS_IOT_ENDPOINT = (process.env.AWS_IOT_ENDPOINT || 'a1ftomq193a3f9-ats.iot.us-east-1.amazonaws.com').trim();
const MQTT_BROKER_URL = AWS_IOT_ENDPOINT && !AWS_IOT_ENDPOINT.includes('YOUR_AWS_IOT_ENDPOINT')
  ? (AWS_IOT_ENDPOINT.startsWith('mqtt') ? AWS_IOT_ENDPOINT : `mqtts://${AWS_IOT_ENDPOINT}:8883`)
  : (process.env.MQTT_BROKER_URL || 'mqtt://broker.emqx.io:1883');
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const MQTT_CA_PATH = process.env.MQTT_CA_PATH || './certs/AmazonRootCA1.pem';
const MQTT_CERT_PATH = process.env.MQTT_CERT_PATH || './certs/403442dcb14e0a38ef4fc1b65681a0dff9775afdd14f900e2d1cea114d3fefa1-certificate.pem.crt';
const MQTT_KEY_PATH = process.env.MQTT_KEY_PATH || './certs/403442dcb14e0a38ef4fc1b65681a0dff9775afdd14f900e2d1cea114d3fefa1-private.pem.key';
const TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX || 'ashan_smart_offgrid_v1';
const IDLE_INTERVAL_MIN = Number(process.env.HISTORY_IDLE_INTERVAL_MINUTES || process.env.HISTORY_LOG_INTERVAL_MINUTES) || 15;
const CHARGE_INTERVAL_MIN = Number(process.env.HISTORY_CHARGE_INTERVAL_MINUTES) || 5;
const DISCHARGE_INTERVAL_MIN = Number(process.env.HISTORY_DISCHARGE_INTERVAL_MINUTES) || 2;
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 60;
const MIN_TRANSITION_SAVE_GAP_MS = 15000;

const TOPICS = {
  STATUS: `${TOPIC_PREFIX}/status`,
  COMMANDS: `${TOPIC_PREFIX}/commands`,
  HISTORY: `${TOPIC_PREFIX}/history`,
  AVAILABILITY: `${TOPIC_PREFIX}/availability`
};

// ---------------------------------------------------------
// In-Memory Live State & Offline Fallback Cache
// ---------------------------------------------------------
let mongoConnected = false;
let mqttConnected = false;
let deviceOnline = false;
let lastSeenTimestamp = 0;
let lastHistorySavedAt = 0;
let lastSavedPhase = null;
let lastSavedVoltage = null;
let lastStateDbSyncAt = 0;
let lastHeartbeatForwardedAt = 0;

let liveStatus = null;
let prevStatusForEvents = null;

let currentCommands = {
  webModeOverride: -1,
  forceChargingActive: false,
  inverter: false,
  smps: false,
  lastHeartbeat: Date.now(),
  otaUrl: ''
};

// In-memory ring buffers if MongoDB is not configured or temporarily offline
const inMemoryHistory = [];
const inMemoryEvents = [];
const MAX_IN_MEMORY_HISTORY = 2000;

function getTelemetryPhase(data) {
  const current = Number(data?.batteryCurrent ?? 0);
  if (current > 0.05 || Boolean(data?.inverterState)) return 'discharging';
  if (current < -0.05) return 'charging';
  return 'idle';
}

function getIntervalMsForPhase(phase) {
  if (phase === 'discharging') return DISCHARGE_INTERVAL_MIN * 60 * 1000;
  if (phase === 'charging') return CHARGE_INTERVAL_MIN * 60 * 1000;
  return IDLE_INTERVAL_MIN * 60 * 1000;
}

function downsampleMinMax(rows, maxPoints) {
  if (!Array.isArray(rows) || rows.length <= maxPoints || maxPoints < 4) {
    return rows || [];
  }

  const result = [rows[0]];
  const interior = rows.slice(1, -1);
  const bucketCount = Math.max(1, Math.floor((maxPoints - 2) / 2));
  const bucketSize = interior.length / bucketCount;

  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor(b * bucketSize);
    const end = Math.min(interior.length, Math.floor((b + 1) * bucketSize));
    if (start >= end) continue;

    let minIdx = start;
    let maxIdx = start;
    for (let i = start + 1; i < end; i++) {
      const v = Number(interior[i].batteryVoltage ?? 0);
      if (v < Number(interior[minIdx].batteryVoltage ?? 0)) minIdx = i;
      if (v > Number(interior[maxIdx].batteryVoltage ?? 0)) maxIdx = i;
    }

    if (minIdx === maxIdx) {
      result.push(interior[minIdx]);
    } else if (minIdx < maxIdx) {
      result.push(interior[minIdx], interior[maxIdx]);
    } else {
      result.push(interior[maxIdx], interior[minIdx]);
    }
  }

  result.push(rows[rows.length - 1]);
  return result;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatLocalDayMeta(epochSec, tzOffsetMin = 0) {
  const localDate = new Date(epochSec * 1000 - tzOffsetMin * 60 * 1000);
  const y = localDate.getUTCFullYear();
  const m = localDate.getUTCMonth();
  const d = localDate.getUTCDate();
  const wd = localDate.getUTCDay();
  const dateKey = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return {
    dateKey,
    dateStr: `${MONTH_NAMES[m]} ${d}, ${y}`,
    shortDay: WEEKDAY_NAMES[wd]
  };
}

function buildDailyUptime(rows, days = 7, tzOffsetMin = 0) {
  const dailyMap = new Map();
  let inDeepDischarge = false;

  for (let i = 0; i < rows.length; i++) {
    const curr = rows[i];
    const meta = formatLocalDayMeta(curr.epoch, tzOffsetMin);
    if (!dailyMap.has(meta.dateKey)) {
      dailyMap.set(meta.dateKey, {
        dateKey: meta.dateKey,
        dateStr: meta.dateStr,
        shortDay: meta.shortDay,
        uptimeSec: 0,
        deepDischargeCount: 0,
        minVoltage: Number(curr.batteryVoltage),
        maxVoltage: Number(curr.batteryVoltage)
      });
    }

    const bucket = dailyMap.get(meta.dateKey);
    const v = Number(curr.batteryVoltage ?? 0);
    if (v > 1) {
      bucket.minVoltage = Math.min(bucket.minVoltage, v);
      bucket.maxVoltage = Math.max(bucket.maxVoltage, v);
    }

    const dtSec = i < rows.length - 1
      ? Math.min(Math.max(Number(rows[i + 1].epoch) - Number(curr.epoch), 0), 30 * 60)
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

// Connected SSE Clients for instant real-time frontend push
const sseClients = new Set();

function broadcastSSE(eventType, payload) {
  const dataString = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(dataString);
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

async function pruneExpiredRecords() {
  const cutoffEpoch = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;

  while (inMemoryHistory.length > 0 && inMemoryHistory[0].epoch < cutoffEpoch) {
    inMemoryHistory.shift();
  }
  for (let i = inMemoryEvents.length - 1; i >= 0; i--) {
    if (inMemoryEvents[i].epoch < cutoffEpoch) {
      inMemoryEvents.splice(i, 1);
    }
  }

  if (!mongoConnected) return;
  try {
    const [histRes, eventRes] = await Promise.all([
      HistoryLog.deleteMany({ epoch: { $lt: cutoffEpoch } }),
      EventLog.deleteMany({ epoch: { $lt: cutoffEpoch } })
    ]);
    if (histRes.deletedCount > 0 || eventRes.deletedCount > 0) {
      console.log(`[Retention] Pruned ${histRes.deletedCount} history & ${eventRes.deletedCount} event records older than ${RETENTION_DAYS}d`);
    }
  } catch (err) {
    console.warn('[Retention] Cleanup error:', err.message);
  }
}

// ---------------------------------------------------------
// MongoDB Connection & Helper Functions
// ---------------------------------------------------------
async function connectMongoDB() {
  if (!MONGODB_URI) {
    console.warn('[MongoDB] No MONGODB_URI provided. Running with in-memory storage fallback.');
    return;
  }

  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000
    });
    mongoConnected = true;
    console.log('[MongoDB] Connected successfully');

    HistoryLog.createIndexes().catch(() => {});
    EventLog.createIndexes().catch(() => {});
    pruneExpiredRecords();

    // Load last persisted state from MongoDB on startup
    const savedState = await SystemState.findOne({ deviceId: 'esp32_main' }).lean();
    if (savedState) {
      if (savedState.lastStatus && Object.keys(savedState.lastStatus).length > 0) {
        liveStatus = savedState.lastStatus;
      }
      if (savedState.commands) {
        currentCommands = { ...currentCommands, ...savedState.commands };
      }
      if (savedState.lastSeen) {
        lastSeenTimestamp = new Date(savedState.lastSeen).getTime();
      }
    }
  } catch (err) {
    mongoConnected = false;
    console.warn('[MongoDB] Connection failed (using in-memory fallback, will retry):', err.message);
    setTimeout(connectMongoDB, 15000);
  }
}

setInterval(pruneExpiredRecords, 6 * 60 * 60 * 1000);

mongoose.connection.on('disconnected', () => {
  mongoConnected = false;
});
mongoose.connection.on('connected', () => {
  mongoConnected = true;
});

async function saveHistorySnapshot(snapshot, syncedFromOffline = false) {
  const epoch = Number(snapshot.epoch) || Math.floor(Date.now() / 1000);
  const record = {
    epoch,
    time: snapshot.time || new Date(epoch * 1000).toTimeString().slice(0, 8),
    batteryVoltage: Number(snapshot.batteryVoltage ?? 0),
    batteryCurrent: Number(snapshot.batteryCurrent ?? 0),
    batterySoc: Number(snapshot.batterySoc ?? 0),
    cellVoltages: Array.isArray(snapshot.cellVoltages) ? snapshot.cellVoltages : [0, 0, 0, 0],
    solarVoltage: Number(snapshot.solarVoltage ?? 0),
    gridPresent: Boolean(snapshot.gridPresent),
    inverterState: Boolean(snapshot.inverterState),
    smpsState: Boolean(snapshot.smpsState),
    mode: snapshot.mode || snapshot.modeString || 'POWER OFF',
    syncedFromOfflineBuffer: syncedFromOffline,
    phase: snapshot.phase || getTelemetryPhase(snapshot),
    source: snapshot.source || (syncedFromOffline ? 'offline-buffer' : 'esp32'),
    recordedAt: new Date(epoch * 1000)
  };

  // Update in-memory fallback list (deduplicate by epoch)
  const existingIdx = inMemoryHistory.findIndex(item => item.epoch === record.epoch);
  if (existingIdx !== -1) {
    inMemoryHistory[existingIdx] = record;
  } else {
    inMemoryHistory.push(record);
    inMemoryHistory.sort((a, b) => a.epoch - b.epoch);
    if (inMemoryHistory.length > MAX_IN_MEMORY_HISTORY) {
      inMemoryHistory.shift();
    }
  }

  if (mongoConnected) {
    try {
      await HistoryLog.findOneAndUpdate(
        { epoch: record.epoch },
        { $set: record },
        { upsert: true, new: true }
      );
    } catch (err) {
      console.error('[MongoDB] Failed to save history snapshot:', err.message);
    }
  }
}

async function logSystemEvent(eventText, type = 'info', details = {}, source = 'system', customEpoch) {
  const epoch = Number(customEpoch) || Math.floor(Date.now() / 1000);
  const recordedAt = new Date(epoch * 1000);
  const entry = {
    epoch,
    type,
    event: eventText,
    details,
    source,
    recordedAt,
    createdAt: recordedAt.toISOString()
  };

  inMemoryEvents.unshift(entry);
  if (inMemoryEvents.length > 200) inMemoryEvents.pop();

  broadcastSSE('event', entry);

  if (mongoConnected) {
    try {
      await EventLog.create(entry);
    } catch (err) {
      console.error('[MongoDB] Failed to save event log:', err.message);
    }
  }
}

function computeCellSpread(cells) {
  if (!Array.isArray(cells)) return 0;
  const valid = cells.map(Number).filter(v => v > 1.0);
  if (valid.length < 2) return 0;
  return Math.max(...valid) - Math.min(...valid);
}

async function detectAndLogTransitions(prev, curr) {
  if (!prev) return;

  if (prev.gridPresent !== curr.gridPresent) {
    await logSystemEvent(
      curr.gridPresent ? 'Main Grid Restored (ONLINE)' : 'Main Grid Failure (POWER CUT)',
      curr.gridPresent ? 'success' : 'danger',
      { batteryVoltage: curr.batteryVoltage }
    );
  }
  if (prev.inverterState !== curr.inverterState) {
    await logSystemEvent(
      `Inverter Relay turned ${curr.inverterState ? 'ON' : 'OFF'}`,
      curr.inverterState ? 'warning' : 'info',
      { mode: curr.modeString, batteryVoltage: curr.batteryVoltage }
    );
  }
  if (prev.smpsState !== curr.smpsState) {
    await logSystemEvent(
      `SMPS Charger turned ${curr.smpsState ? 'ON (Charging)' : 'OFF (Standby)'}`,
      curr.smpsState ? 'info' : 'success',
      { mode: curr.modeString, batteryVoltage: curr.batteryVoltage }
    );
  }
  if (prev.modeString !== curr.modeString) {
    await logSystemEvent(
      `System Mode changed: ${prev.modeString} → ${curr.modeString}`,
      'action',
      { webModeOverride: curr.webModeOverride }
    );
  }
  if (!prev.flatlineDetected && curr.flatlineDetected) {
    await logSystemEvent(
      'dV/dt Flatline Detected — Battery full, stopping charge',
      'success',
      { batteryVoltage: curr.batteryVoltage }
    );
  }
  if (Number(prev.batteryVoltage) > 12.2 && Number(curr.batteryVoltage) <= 12.2 && Number(curr.batteryVoltage) > 5.0) {
    await logSystemEvent(
      `Low Battery Voltage Alert (${Number(curr.batteryVoltage).toFixed(2)} V)`,
      'danger',
      { batteryVoltage: curr.batteryVoltage, batterySoc: curr.batterySoc }
    );
  }
  const prevSpread = computeCellSpread(prev.cellVoltages);
  const currSpread = computeCellSpread(curr.cellVoltages);
  if (prevSpread < 0.08 && currSpread >= 0.08) {
    await logSystemEvent(
      `4S Cell Imbalance Alert (ΔV ${(currSpread * 1000).toFixed(0)} mV)`,
      'warning',
      { cellVoltages: curr.cellVoltages }
    );
  }
}

// ---------------------------------------------------------
// MQTT Broker Connection & Handlers (Supports AWS IoT Core mTLS & Standard MQTT)
// ---------------------------------------------------------
const mqttOptions = {
  clientId: `offgrid_backend_${Math.random().toString(16).slice(2, 10)}`,
  clean: true,
  connectTimeout: 5000,
  reconnectPeriod: 3000
};

if (MQTT_USERNAME) mqttOptions.username = MQTT_USERNAME;
if (MQTT_PASSWORD) mqttOptions.password = MQTT_PASSWORD;

// Load AWS IoT Core mTLS Certificates if connecting over mqtts:// (Port 8883)
if (MQTT_BROKER_URL.startsWith('mqtts://')) {
  try {
    const caFull = path.resolve(__dirname, MQTT_CA_PATH);
    const certFull = path.resolve(__dirname, MQTT_CERT_PATH);
    const keyFull = path.resolve(__dirname, MQTT_KEY_PATH);

    if (fs.existsSync(caFull) && fs.existsSync(certFull) && fs.existsSync(keyFull)) {
      mqttOptions.ca = fs.readFileSync(caFull);
      mqttOptions.cert = fs.readFileSync(certFull);
      mqttOptions.key = fs.readFileSync(keyFull);
      mqttOptions.rejectUnauthorized = true;
      console.log('[MQTT] Loaded AWS IoT Core mTLS Certificates from ./certs/');
    } else {
      console.warn('[MQTT] Certificate files not found at configured paths, check MQTT_CA_PATH / MQTT_CERT_PATH / MQTT_KEY_PATH');
    }
  } catch (certErr) {
    console.error('[MQTT] Failed to load mTLS certificates:', certErr.message);
  }
}

const mqttClient = mqtt.connect(MQTT_BROKER_URL, mqttOptions);

mqttClient.on('connect', () => {
  mqttConnected = true;
  console.log(`[MQTT] Connected to broker: ${MQTT_BROKER_URL}`);

  mqttClient.subscribe([TOPICS.STATUS, TOPICS.HISTORY, TOPICS.AVAILABILITY], { qos: 1 }, (err) => {
    if (err) {
      console.error('[MQTT] Subscription error:', err.message);
    } else {
      console.log(`[MQTT] Subscribed to topics under '${TOPIC_PREFIX}/#'`);
    }
  });
});

mqttClient.on('reconnect', () => {
  mqttConnected = false;
});

mqttClient.on('offline', () => {
  mqttConnected = false;
});

mqttClient.on('error', (err) => {
  console.error('[MQTT] Error:', err.message);
});

mqttClient.on('message', async (topic, messageBuffer) => {
  const payloadStr = messageBuffer.toString();

  // 1. ESP32 Availability (LWT Online/Offline)
  if (topic === TOPICS.AVAILABILITY) {
    const isOnline = payloadStr.trim().toLowerCase() === 'online';
    const changed = deviceOnline !== isOnline;
    deviceOnline = isOnline;
    if (isOnline) lastSeenTimestamp = Date.now();

    if (changed) {
      await logSystemEvent(
        isOnline ? 'ESP32 Connected to MQTT Broker (ONLINE)' : 'ESP32 Connection Interrupted (OFFLINE - Autonomous Local Mode Active)',
        isOnline ? 'success' : 'warning'
      );
      broadcastSSE('availability', { deviceOnline, lastSeen: lastSeenTimestamp });
    }
    return;
  }

  // 2. ESP32 Live Status Telemetry
  if (topic === TOPICS.STATUS) {
    try {
      const data = JSON.parse(payloadStr);
      deviceOnline = true;
      lastSeenTimestamp = Date.now();

      const prevSnap = prevStatusForEvents;
      await detectAndLogTransitions(prevSnap, data);
      prevStatusForEvents = { ...data };
      liveStatus = {
        ...data,
        deviceOnline: true,
        mqttConnected: true,
        mongoConnected,
        lastSeen: lastSeenTimestamp
      };

      // Push immediately to any open React dashboard via SSE
      broadcastSSE('status', liveStatus);

      // Adaptive MongoDB History Logging (15m idle, 5m charging, 2m discharging, + key transitions)
      const now = Date.now();
      const batVolt = Number(data.batteryVoltage);
      if (batVolt > 5.0) {
        const phase = getTelemetryPhase(data);
        const requiredIntervalMs = getIntervalMsForPhase(phase);
        const phaseChanged = lastSavedPhase !== null && lastSavedPhase !== phase;
        const relayOrGridChanged = Boolean(
          prevSnap && (
            prevSnap.gridPresent !== data.gridPresent
            || prevSnap.inverterState !== data.inverterState
            || prevSnap.smpsState !== data.smpsState
            || prevSnap.modeString !== data.modeString
          )
        );
        const voltageJump = lastSavedVoltage !== null && Math.abs(batVolt - lastSavedVoltage) >= 0.35;

        const shouldSave = lastHistorySavedAt === 0
          || (now - lastHistorySavedAt >= requiredIntervalMs)
          || ((phaseChanged || relayOrGridChanged || voltageJump) && (now - lastHistorySavedAt >= MIN_TRANSITION_SAVE_GAP_MS));

        if (shouldSave) {
          lastHistorySavedAt = now;
          lastSavedPhase = phase;
          lastSavedVoltage = batVolt;
          await saveHistorySnapshot(
            {
              epoch: data.epoch || Math.floor(now / 1000),
              batteryVoltage: data.batteryVoltage,
              batteryCurrent: data.batteryCurrent,
              batterySoc: data.batterySoc,
              cellVoltages: data.cellVoltages,
              solarVoltage: data.solarVoltage,
              gridPresent: data.gridPresent,
              inverterState: data.inverterState,
              smpsState: data.smpsState,
              mode: data.modeString,
              phase,
              source: 'esp32'
            },
            false
          );
        }
      }

      // Persist latest status to MongoDB SystemState (throttled to every 30s)
      if (mongoConnected && now - lastStateDbSyncAt >= 30000) {
        lastStateDbSyncAt = now;
        await SystemState.findOneAndUpdate(
          { deviceId: 'esp32_main' },
          {
            $set: {
              lastStatus: liveStatus,
              commands: currentCommands,
              deviceOnline: true,
              lastSeen: new Date(lastSeenTimestamp)
            }
          },
          { upsert: true }
        );
      }
    } catch (err) {
      console.error('[MQTT] Failed to parse status JSON:', err.message);
    }
    return;
  }

  // 3. ESP32 Offline-Buffered or Direct History Packet
  if (topic === TOPICS.HISTORY) {
    try {
      const histData = JSON.parse(payloadStr);
      if (Array.isArray(histData)) {
        for (const item of histData) {
          await saveHistorySnapshot(item, true);
        }
        await logSystemEvent(`Synced ${histData.length} offline history records from ESP32 buffer to MongoDB`, 'info');
      } else {
        await saveHistorySnapshot(histData, Boolean(histData.offlineBuffered));
        lastHistorySavedAt = Date.now();
      }
    } catch (err) {
      console.error('[MQTT] Failed to parse history JSON:', err.message);
    }
  }
});

// Helper to publish commands to ESP32 via MQTT (retain: false for AWS IoT Core & physical switch safety)
function publishCommandToEsp32(cmdPatch) {
  currentCommands = { ...currentCommands, ...cmdPatch };

  if (mqttConnected) {
    mqttClient.publish(TOPICS.COMMANDS, JSON.stringify(cmdPatch), { qos: 1, retain: false });
  }

  if (mongoConnected) {
    SystemState.findOneAndUpdate(
      { deviceId: 'esp32_main' },
      { $set: { commands: currentCommands } },
      { upsert: true }
    ).catch(() => {});
  }
}

// Mark device offline if no status received for > 15 seconds
setInterval(() => {
  if (deviceOnline && lastSeenTimestamp > 0 && Date.now() - lastSeenTimestamp > 15000) {
    deviceOnline = false;
    broadcastSSE('availability', { deviceOnline: false, lastSeen: lastSeenTimestamp });
  }
}, 5000);

// ---------------------------------------------------------
// Express REST & SSE Endpoints
// ---------------------------------------------------------

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mqttConnected,
    mongoConnected,
    deviceOnline,
    lastSeen: lastSeenTimestamp,
    topicPrefix: TOPIC_PREFIX,
    storagePolicy: {
      idleIntervalMin: IDLE_INTERVAL_MIN,
      chargeIntervalMin: CHARGE_INTERVAL_MIN,
      dischargeIntervalMin: DISCHARGE_INTERVAL_MIN,
      retentionDays: RETENTION_DAYS
    }
  });
});

// Real-Time Server-Sent Events (SSE) Stream for React Dashboard
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Wake up ESP32 3-hour active session timer when a dashboard connects
  const now = Date.now();
  if (now - lastHeartbeatForwardedAt > 20000) {
    lastHeartbeatForwardedAt = now;
    publishCommandToEsp32({ lastHeartbeat: now }, false);
  }

  // Send immediate snapshot on connect
  if (liveStatus) {
    res.write(`event: status\ndata: ${JSON.stringify({ ...liveStatus, deviceOnline, mqttConnected, mongoConnected })}\n\n`);
  }

  sseClients.add(res);

  const keepAliveTimer = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch (e) {
      clearInterval(keepAliveTimer);
      sseClients.delete(res);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(keepAliveTimer);
    sseClients.delete(res);
  });
});

// Get System Status (REST endpoint compatible with esp32Api.js)
app.get('/api/status', (req, res) => {
  // Forward app heartbeat to ESP32 every 25s while dashboard is polling/viewing
  const now = Date.now();
  if (now - lastHeartbeatForwardedAt > 25000) {
    lastHeartbeatForwardedAt = now;
    publishCommandToEsp32({ lastHeartbeat: now }, false);
  }

  if (!liveStatus) {
    return res.status(200).json({
      isConnected: false,
      deviceOnline: false,
      mqttConnected,
      mongoConnected,
      error: 'Waiting for initial MQTT telemetry from ESP32...'
    });
  }

  res.json({
    ...liveStatus,
    deviceOnline,
    mqttConnected,
    mongoConnected,
    lastSeen: lastSeenTimestamp,
    isConnected: deviceOnline || (now - lastSeenTimestamp < 30000)
  });
});

// Heartbeat Endpoint
app.post('/api/heartbeat', (req, res) => {
  const now = Date.now();
  if (now - lastHeartbeatForwardedAt > 15000) {
    lastHeartbeatForwardedAt = now;
    publishCommandToEsp32({ lastHeartbeat: now }, false);
  }
  res.json({ success: true, lastHeartbeat: now });
});

// Set Operating Mode
const handleModeRoute = async (req, res) => {
  const rawMode = req.query.mode !== undefined ? req.query.mode : req.body?.mode;
  const modeVal = Number(rawMode);

  if (Number.isNaN(modeVal) || modeVal < -1 || modeVal > 4) {
    return res.status(400).json({ error: 'Invalid mode value (-1 to 4)' });
  }

  if (liveStatus) {
    liveStatus.webModeOverride = modeVal;
  }
  publishCommandToEsp32({ webModeOverride: modeVal, lastHeartbeat: Date.now() }, true);
  await logSystemEvent(`Web Command: System Mode Override set to ${modeVal}`, 'action');

  res.json({ success: true, webModeOverride: modeVal });
};
app.post('/api/mode', handleModeRoute);
app.get('/api/mode', handleModeRoute);

// Toggle Force Charging
const handleChargeRoute = async (req, res) => {
  const rawActive = req.query.active !== undefined ? req.query.active : req.body?.active;
  let nextActive;
  if (rawActive !== undefined) {
    nextActive = String(rawActive) === 'true' || String(rawActive) === '1' || rawActive === true;
  } else {
    nextActive = !currentCommands.forceChargingActive;
  }

  if (liveStatus) {
    liveStatus.forceChargingActive = nextActive;
    liveStatus.smpsState = nextActive;
  }
  publishCommandToEsp32({ forceChargingActive: nextActive, lastHeartbeat: Date.now() }, true);
  await logSystemEvent(`Web Command: Force Charging ${nextActive ? 'ENABLED' : 'DISABLED'}`, nextActive ? 'warning' : 'info');

  res.json({ success: true, forceChargingActive: nextActive });
};
app.post('/api/charge', handleChargeRoute);
app.get('/api/charge', handleChargeRoute);

// Manual Relay Control
const handleRelayRoute = async (req, res) => {
  const invParam = req.query.inverter !== undefined ? req.query.inverter : req.body?.inverter;
  const smpsParam = req.query.smps !== undefined ? req.query.smps : req.body?.smps;

  const patch = { lastHeartbeat: Date.now() };
  if (invParam !== undefined) {
    const invState = String(invParam) === 'true' || String(invParam) === '1' || invParam === true;
    patch.inverter = invState;
    if (liveStatus) liveStatus.inverterState = invState;
  }
  if (smpsParam !== undefined) {
    const smpsState = String(smpsParam) === 'true' || String(smpsParam) === '1' || smpsParam === true;
    patch.smps = smpsState;
    if (liveStatus) liveStatus.smpsState = smpsState;
  }

  publishCommandToEsp32(patch, false);
  await logSystemEvent(`Web Command: Manual Relay Override (${JSON.stringify(patch)})`, 'action');

  res.json({ success: true, ...patch });
};
app.post('/api/relay', handleRelayRoute);
app.get('/api/relay', handleRelayRoute);

// Trigger OTA Firmware Update
const handleOtaRoute = async (req, res) => {
  const firmwareUrl = req.query.url || req.body?.url;
  if (!firmwareUrl) {
    return res.status(400).json({ error: 'Missing firmware URL parameter' });
  }

  publishCommandToEsp32({ otaUrl: firmwareUrl, lastHeartbeat: Date.now() }, false);
  await logSystemEvent(`Web Command: OTA Firmware Update triggered (${firmwareUrl})`, 'warning');

  res.json({
    success: true,
    message: 'OTA Update command pushed to ESP32 via MQTT!'
  });
};
app.post('/api/ota-update', handleOtaRoute);
app.get('/api/ota-update', handleOtaRoute);

// Fetch History from MongoDB with min/max downsampling for multi-day trends
app.get('/api/history', async (req, res) => {
  const days = Math.min(RETENTION_DAYS, Math.max(1, Number(req.query.days) || 7));
  const maxPoints = Math.min(2000, Math.max(50, Number(req.query.maxPoints) || 500));
  const raw = req.query.raw === 'true';
  const minEpoch = Math.floor(Date.now() / 1000) - days * 86400;

  if (mongoConnected) {
    try {
      const rows = await HistoryLog.find({ epoch: { $gte: minEpoch } })
        .sort({ epoch: 1 })
        .select({
          _id: 0,
          epoch: 1,
          time: 1,
          batteryVoltage: 1,
          batteryCurrent: 1,
          batterySoc: 1,
          cellVoltages: 1,
          solarVoltage: 1,
          gridPresent: 1,
          inverterState: 1,
          smpsState: 1,
          mode: 1,
          phase: 1
        })
        .limit(45000)
        .lean();
      return res.json(raw ? rows : downsampleMinMax(rows, maxPoints));
    } catch (err) {
      console.error('[MongoDB] History query error:', err.message);
    }
  }

  // Fallback to in-memory history if MongoDB is not connected
  const filtered = inMemoryHistory.filter(h => h.epoch >= minEpoch);
  res.json(raw ? filtered : downsampleMinMax(filtered, maxPoints));
});

// Daily Inverter Uptime & Deep-Discharge Summary
app.get('/api/history/daily', async (req, res) => {
  const days = Math.min(RETENTION_DAYS, Math.max(1, Number(req.query.days) || 7));
  const tzOffsetMin = Number(req.query.tzOffsetMin) || 0;
  const minEpoch = Math.floor(Date.now() / 1000) - days * 86400;

  if (mongoConnected) {
    try {
      const rows = await HistoryLog.find({ epoch: { $gte: minEpoch } })
        .sort({ epoch: 1 })
        .select({ _id: 0, epoch: 1, batteryVoltage: 1, inverterState: 1, mode: 1, phase: 1 })
        .limit(45000)
        .lean();
      return res.json(buildDailyUptime(rows, days, tzOffsetMin));
    } catch (err) {
      console.error('[MongoDB] Daily uptime query error:', err.message);
    }
  }

  const filtered = inMemoryHistory.filter(h => h.epoch >= minEpoch);
  res.json(buildDailyUptime(filtered, days, tzOffsetMin));
});

// Persist Event Log from Dashboard UI
const ALLOWED_EVENT_TYPES = new Set(['info', 'action', 'warning', 'danger', 'success']);
app.post('/api/events', async (req, res) => {
  const rawEvent = typeof req.body?.event === 'string' ? req.body.event.trim() : '';
  if (!rawEvent) {
    return res.status(400).json({ error: 'Missing event description' });
  }
  const cleanEvent = rawEvent.slice(0, 240);
  const cleanType = ALLOWED_EVENT_TYPES.has(req.body?.type) ? req.body.type : 'info';
  const details = req.body?.details && typeof req.body.details === 'object' ? req.body.details : {};

  await logSystemEvent(cleanEvent, cleanType, details, 'ui');
  res.json({ success: true });
});

// Fetch Event Logs from MongoDB
app.get('/api/events', async (req, res) => {
  const days = Math.min(RETENTION_DAYS, Math.max(1, Number(req.query.days) || RETENTION_DAYS));
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 150));
  const minEpoch = Math.floor(Date.now() / 1000) - days * 86400;

  if (mongoConnected) {
    try {
      const events = await EventLog.find({ epoch: { $gte: minEpoch } })
        .sort({ epoch: -1 })
        .limit(limit)
        .lean();
      return res.json(events);
    } catch (err) {
      console.error('[MongoDB] Events query error:', err.message);
    }
  }
  res.json(inMemoryEvents.filter(e => e.epoch >= minEpoch).slice(0, limit));
});

// Start Server
connectMongoDB().then(() => {
  app.listen(PORT, () => {
    console.log(`[Backend] Smart Off-Grid Hosted Server running on port ${PORT}`);
  });
});
