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
const HISTORY_INTERVAL_MS = (Number(process.env.HISTORY_LOG_INTERVAL_MINUTES) || 15) * 60 * 1000;

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
const MAX_IN_MEMORY_HISTORY = 700; // ~7 days of 15-min intervals

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
    syncedFromOfflineBuffer: syncedFromOffline
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

async function logSystemEvent(eventText, type = 'info', details = {}) {
  const entry = {
    epoch: Math.floor(Date.now() / 1000),
    type,
    event: eventText,
    details,
    createdAt: new Date().toISOString()
  };

  inMemoryEvents.unshift(entry);
  if (inMemoryEvents.length > 100) inMemoryEvents.pop();

  broadcastSSE('event', entry);

  if (mongoConnected) {
    try {
      await EventLog.create(entry);
    } catch (err) {
      console.error('[MongoDB] Failed to save event log:', err.message);
    }
  }
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

      await detectAndLogTransitions(prevStatusForEvents, data);
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

      // Automatic 15-minute History Logging to MongoDB (offloads ESP32!)
      const now = Date.now();
      if (lastHistorySavedAt === 0 || now - lastHistorySavedAt >= HISTORY_INTERVAL_MS) {
        lastHistorySavedAt = now;
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
            mode: data.modeString
          },
          false
        );
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

// Helper to publish commands to ESP32 via MQTT
function publishCommandToEsp32(cmdPatch, retain = false) {
  currentCommands = { ...currentCommands, ...cmdPatch };

  if (mqttConnected) {
    mqttClient.publish(TOPICS.COMMANDS, JSON.stringify(cmdPatch), { qos: 1, retain });
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
    topicPrefix: TOPIC_PREFIX
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

// Fetch 7-Day (or custom days) History from MongoDB
app.get('/api/history', async (req, res) => {
  const days = Number(req.query.days) || 7;
  const minEpoch = Math.floor(Date.now() / 1000) - days * 86400;

  if (mongoConnected) {
    try {
      const logs = await HistoryLog.find({ epoch: { $gte: minEpoch } })
        .sort({ epoch: 1 })
        .limit(2000)
        .lean();
      return res.json(logs);
    } catch (err) {
      console.error('[MongoDB] History query error:', err.message);
    }
  }

  // Fallback to in-memory history if MongoDB is not connected
  const filtered = inMemoryHistory.filter(h => h.epoch >= minEpoch);
  res.json(filtered);
});

// Fetch Event Logs from MongoDB
app.get('/api/events', async (req, res) => {
  if (mongoConnected) {
    try {
      const events = await EventLog.find().sort({ epoch: -1 }).limit(100).lean();
      return res.json(events);
    } catch (err) {
      console.error('[MongoDB] Events query error:', err.message);
    }
  }
  res.json(inMemoryEvents);
});

// Start Server
connectMongoDB().then(() => {
  app.listen(PORT, () => {
    console.log(`[Backend] Smart Off-Grid Hosted Server running on port ${PORT}`);
  });
});
