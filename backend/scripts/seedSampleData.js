import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { HistoryLog } from '../models/HistoryLog.js';
import { EventLog } from '../models/EventLog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI || '';
const CLEAR_ONLY = process.argv.includes('--clear');

const OUTAGE_WINDOWS = {
  0: { startH: 10.5, endH: 12.5, mode: 'POWER CUT', baseCurrent: 11.8 },
  2: { startH: 13.0, endH: 15.5, mode: 'MANUAL', baseCurrent: 15.4, deepDischarge: true },
  4: { startH: 11.25, endH: 12.75, mode: 'POWER CUT', baseCurrent: 12.6 }
};

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function restingPackVoltage(soc) {
  const curve = [
    [10, 12.22],
    [15, 12.48],
    [25, 12.92],
    [40, 13.14],
    [65, 13.26],
    [85, 13.34],
    [95, 13.42],
    [100, 13.52]
  ];
  if (soc <= curve[0][0]) return curve[0][1];
  if (soc >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
  for (let i = 1; i < curve.length; i++) {
    const [s1, v1] = curve[i];
    if (soc <= s1) {
      const [s0, v0] = curve[i - 1];
      return v0 + ((soc - s0) / (s1 - s0)) * (v1 - v0);
    }
  }
  return 13.35;
}

function splitToFourCells(packV, step) {
  const avg = packV / 4;
  const offsets = [
    -0.005 + Math.sin(step * 0.4) * 0.002,
    0.004 + Math.cos(step * 0.5) * 0.002,
    0.007 + Math.sin(step * 0.3 + 1) * 0.002,
    -0.006 + Math.cos(step * 0.4 + 2) * 0.002
  ];
  const cells = offsets.map((off) => Number((avg + off).toFixed(3)));
  const sum3 = cells[0] + cells[1] + cells[2];
  cells[3] = Number((packV - sum3).toFixed(3));
  return cells;
}

function generateFiveDaySampleData(nowEpoch) {
  const startEpoch = nowEpoch - 5 * 86400;
  const endEpoch = nowEpoch - 90;

  const historyRecords = [];
  const eventRecords = [];

  let cursor = startEpoch;
  let step = 0;
  let soc = 84;
  let nightChargeDoneForDay = -1;
  let eveningChargeDoneForDay = -1;
  let lowAlertFiredForDay = -1;
  let prev = null;

  while (cursor <= endEpoch) {
    const dayIdx = Math.min(4, Math.floor((cursor - startEpoch) / 86400));
    const d = new Date(cursor * 1000);
    const hourFloat = d.getHours() + d.getMinutes() / 60;
    const outage = OUTAGE_WINDOWS[dayIdx];

    let gridPresent = true;
    let inverterState = false;
    let smpsState = false;
    let mode = 'ECO MODE';
    let phase = 'idle';
    let batteryCurrent = 0;
    let intervalSec = 15 * 60;

    // 1. Scheduled daytime grid outage on 3 of the 5 days (2-min discharge resolution)
    if (outage && hourFloat >= outage.startH && hourFloat < outage.endH) {
      gridPresent = false;
      inverterState = true;
      mode = outage.mode;
      phase = 'discharging';
      intervalSec = 2 * 60;
      const ripple = Math.sin(step * 0.55) * 1.1;
      batteryCurrent = Number((outage.baseCurrent + ripple).toFixed(2));
      if (outage.deepDischarge && soc > 26) {
        soc = Math.max(14, soc - 2.6); // faster load pull on the deep-discharge day
      }
    }
    // 2. Evening ECO battery-priority discharge (19:00 - 21:15) (2-min resolution)
    else if (hourFloat >= 19.0 && hourFloat < 21.25 && soc > 48) {
      gridPresent = true;
      inverterState = true;
      mode = 'ECO MODE';
      phase = 'discharging';
      intervalSec = 2 * 60;
      batteryCurrent = Number((9.8 + Math.sin(step * 0.45) * 2.1).toFixed(2));
    }
    // 3. 1:00 AM Night Top-Up (5-min charging resolution)
    else if (hourFloat >= 1.0 && hourFloat < 2.25 && nightChargeDoneForDay !== dayIdx && soc < 98) {
      smpsState = true;
      mode = 'ECO MODE';
      phase = 'charging';
      intervalSec = 5 * 60;
      batteryCurrent = Number((-9.6 - Math.cos(step * 0.4) * 1.3).toFixed(2));
    }
    // 4. 5:30 PM Evening Top-Up / post-outage recharge (5-min charging resolution)
    else if (
      ((hourFloat >= 17.5 && hourFloat < 18.9) || (outage && hourFloat >= outage.endH && hourFloat < outage.endH + 1.5))
      && eveningChargeDoneForDay !== dayIdx
      && soc < 98
    ) {
      smpsState = true;
      mode = 'ECO MODE';
      phase = 'charging';
      intervalSec = 5 * 60;
      batteryCurrent = Number((-12.2 - Math.sin(step * 0.35) * 1.1).toFixed(2));
    }

    // Update SOC using battery current (negative = charging, positive = discharging)
    const dtHours = intervalSec / 3600;
    const capacityAh = outage?.deepDischarge && !gridPresent ? 42 : 70;
    soc = clamp(soc - (batteryCurrent * dtHours / capacityAh) * 100, 12, 100);

    // Calculate realistic pack voltage from resting OCV + charge/discharge polarization
    let packVolt = restingPackVoltage(soc);
    if (phase === 'charging') {
      packVolt += 0.48 + (soc / 100) * 0.65;
      if (outage?.deepDischarge && soc > 96) packVolt = Math.min(14.48, packVolt);
    } else if (phase === 'discharging') {
      const sag = 0.14 + (batteryCurrent / 16) * 0.24;
      packVolt -= sag;
      if (outage?.deepDischarge && hourFloat >= outage.endH - 0.5) {
        packVolt = Math.min(packVolt, 12.34 - (hourFloat - (outage.endH - 0.5)) * 0.22);
      }
    }
    packVolt = Number(clamp(packVolt + Math.sin(step * 0.3) * 0.015, 12.05, 14.52).toFixed(2));

    // Mark top-up completion when reaching absorption / dV/dt cutoff
    if (phase === 'charging' && packVolt >= 14.35 && soc >= 97) {
      if (hourFloat < 6) nightChargeDoneForDay = dayIdx;
      else eveningChargeDoneForDay = dayIdx;
      eventRecords.push({
        epoch: cursor + 5,
        type: 'success',
        event: 'dV/dt Flatline Detected — Battery full, stopping charge',
        details: { batteryVoltage: packVolt, seeded: true },
        source: 'sample-seed',
        recordedAt: new Date((cursor + 5) * 1000)
      });
    }

    const cellVoltages = splitToFourCells(packVolt, step);

    const record = {
      epoch: cursor,
      time: d.toTimeString().slice(0, 8),
      batteryVoltage: packVolt,
      batteryCurrent,
      batterySoc: Math.round(soc),
      cellVoltages,
      solarVoltage: 0,
      gridPresent,
      inverterState,
      smpsState,
      mode,
      syncedFromOfflineBuffer: false,
      phase,
      source: 'sample-seed',
      recordedAt: d
    };
    historyRecords.push(record);

    // Transition EventLog entries aligned with history snapshots
    if (prev) {
      if (prev.gridPresent !== gridPresent) {
        eventRecords.push({
          epoch: cursor,
          type: gridPresent ? 'success' : 'danger',
          event: gridPresent ? 'Main Grid Restored (ONLINE)' : 'Main Grid Failure (POWER CUT)',
          details: { batteryVoltage: packVolt, seeded: true },
          source: 'sample-seed',
          recordedAt: d
        });
      }
      if (prev.mode !== mode) {
        eventRecords.push({
          epoch: cursor + 1,
          type: 'action',
          event: `System Mode changed: ${prev.mode} → ${mode}`,
          details: { seeded: true },
          source: 'sample-seed',
          recordedAt: new Date((cursor + 1) * 1000)
        });
      }
      if (prev.inverterState !== inverterState) {
        eventRecords.push({
          epoch: cursor + 2,
          type: inverterState ? 'warning' : 'info',
          event: `Inverter Relay turned ${inverterState ? 'ON' : 'OFF'}`,
          details: { mode, batteryVoltage: packVolt, seeded: true },
          source: 'sample-seed',
          recordedAt: new Date((cursor + 2) * 1000)
        });
      }
      if (prev.smpsState !== smpsState) {
        eventRecords.push({
          epoch: cursor + 2,
          type: smpsState ? 'info' : 'success',
          event: `SMPS Charger turned ${smpsState ? 'ON (Charging)' : 'OFF (Standby)'}`,
          details: { mode, batteryVoltage: packVolt, seeded: true },
          source: 'sample-seed',
          recordedAt: new Date((cursor + 2) * 1000)
        });
      }
      if (packVolt <= 12.35 && lowAlertFiredForDay !== dayIdx && inverterState) {
        lowAlertFiredForDay = dayIdx;
        eventRecords.push({
          epoch: cursor + 3,
          type: 'danger',
          event: `Low Battery Voltage Alert (${packVolt.toFixed(2)} V in ${mode} mode)`,
          details: { batteryVoltage: packVolt, batterySoc: Math.round(soc), seeded: true },
          source: 'sample-seed',
          recordedAt: new Date((cursor + 3) * 1000)
        });
      }
    }

    prev = record;
    cursor += intervalSec;
    step += 1;
  }

  return { historyRecords, eventRecords };
}

async function run() {
  if (!MONGODB_URI) {
    console.error('[Seed] Missing MONGODB_URI in backend/.env');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('[Seed] Connected to MongoDB Atlas');

  await HistoryLog.createIndexes().catch(() => {});
  await EventLog.createIndexes().catch(() => {});

  const delHist = await HistoryLog.deleteMany({ source: 'sample-seed' });
  const delEvents = await EventLog.deleteMany({
    $or: [{ source: 'sample-seed' }, { 'details.seeded': true }]
  });
  console.log(`[Seed] Cleared previous sample data: ${delHist.deletedCount} history, ${delEvents.deletedCount} events`);

  if (CLEAR_ONLY) {
    await mongoose.disconnect();
    console.log('[Seed] Clear complete.');
    return;
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  const { historyRecords, eventRecords } = generateFiveDaySampleData(nowEpoch);

  let insertedHistory = historyRecords.length;
  try {
    const res = await HistoryLog.insertMany(historyRecords, { ordered: false });
    insertedHistory = res.length;
  } catch (err) {
    if (err?.insertedDocs) {
      insertedHistory = err.insertedDocs.length;
    } else if (err?.result?.nInserted !== undefined) {
      insertedHistory = err.result.nInserted;
    } else {
      throw err;
    }
  }

  const insertedEvents = eventRecords.length
    ? await EventLog.insertMany(eventRecords, { ordered: false })
    : [];

  const countsByPhase = historyRecords.reduce(
    (acc, r) => {
      acc[r.phase] = (acc[r.phase] || 0) + 1;
      return acc;
    },
    { idle: 0, charging: 0, discharging: 0 }
  );

  const firstTs = new Date(historyRecords[0].epoch * 1000).toISOString();
  const lastTs = new Date(historyRecords[historyRecords.length - 1].epoch * 1000).toISOString();

  console.log(`[Seed] Inserted ${insertedHistory} HistoryLog docs (idle@15m=${countsByPhase.idle}, charging@5m=${countsByPhase.charging}, discharging@2m=${countsByPhase.discharging})`);
  console.log(`[Seed] Inserted ${insertedEvents.length} EventLog docs`);
  console.log(`[Seed] Span: ${firstTs} -> ${lastTs}`);

  const ttlIndexes = await HistoryLog.collection.indexes();
  const hasTtl = ttlIndexes.some((idx) => idx.key?.recordedAt === 1 && idx.expireAfterSeconds === 60 * 24 * 60 * 60);
  console.log(`[Seed] 60-day TTL index on HistoryLog.recordedAt: ${hasTtl ? 'ACTIVE' : 'PENDING'}`);

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error('[Seed] Error:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
