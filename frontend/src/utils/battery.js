// Battery math & formatting helpers for the 4S LiFePO4 pack (JK BMS)

export const CELL_COUNT = 4;
export const CELL_V_MIN = 2.5;   // absolute floor used for visuals
export const CELL_V_MAX = 3.65;  // LiFePO4 full-charge ceiling

/**
 * Current sign convention.
 * The firmware JK BMS parser (JK_BMS.h) reports the pack current with the
 * dashboard convention "negative = charging, positive = discharging".
 * If your readings ever look inverted, flip this single flag.
 */
export const CHARGE_CURRENT_IS_NEGATIVE = true;
export const CURRENT_DEADBAND = 0.05; // A

/** Positive = energy going INTO the battery. */
export function chargeCurrent(rawCurrent = 0) {
  return CHARGE_CURRENT_IS_NEGATIVE ? -rawCurrent : rawCurrent;
}

/**
 * Pack flow direction.
 *  - charging    : net current into the pack
 *  - discharging : net current out of the pack (load / inverter)
 *  - float       : charger relay ON but no net current (full / absorption)
 *  - idle        : nothing flowing
 */
export function getFlowDirection(rawCurrent = 0, chargerOn = false) {
  const c = chargeCurrent(rawCurrent);
  if (c > CURRENT_DEADBAND) return 'charging';
  if (c < -CURRENT_DEADBAND) return 'discharging';
  return chargerOn ? 'float' : 'idle';
}

export const DIRECTION_META = {
  charging:    { label: 'Charging',    short: 'CHG',  color: 'var(--c-charge)' },
  discharging: { label: 'Discharging', short: 'DSG',  color: 'var(--c-discharge)' },
  float:       { label: 'Float',       short: 'FLT',  color: 'var(--c-brand)' },
  idle:        { label: 'Idle',        short: 'IDLE', color: 'var(--text-3)' },
  offline:     { label: 'No Data',     short: '—',    color: 'var(--text-4)' },
};

// LiFePO4 resting-voltage → SOC lookup (approximate, per cell)
const LFP_CURVE = [
  [2.50, 0], [2.90, 2], [3.00, 5], [3.10, 9], [3.20, 17], [3.24, 25],
  [3.26, 35], [3.28, 45], [3.30, 60], [3.32, 72], [3.33, 80],
  [3.35, 88], [3.40, 94], [3.45, 97], [3.55, 99], [3.65, 100],
];

export function cellSocFromVoltage(v) {
  if (!v || v <= LFP_CURVE[0][0]) return 0;
  if (v >= LFP_CURVE[LFP_CURVE.length - 1][0]) return 100;
  for (let i = 1; i < LFP_CURVE.length; i++) {
    const [v1, s1] = LFP_CURVE[i];
    if (v <= v1) {
      const [v0, s0] = LFP_CURVE[i - 1];
      return Math.round(s0 + ((v - v0) / (v1 - v0)) * (s1 - s0));
    }
  }
  return 100;
}

export function packSocFromVoltage(packV) {
  if (!packV) return 0;
  return cellSocFromVoltage(packV / CELL_COUNT);
}

/** Health band for a single cell voltage. */
export function cellBand(v) {
  if (!v || v < 1) return 'offline';
  if (v < 2.9 || v > 3.65) return 'critical';
  if (v < 3.1) return 'low';
  if (v > 3.5) return 'high';
  return 'normal';
}

export const BAND_META = {
  critical: { label: 'Critical', color: 'var(--c-danger)' },
  low:      { label: 'Low',      color: 'var(--c-discharge)' },
  high:     { label: 'Top',      color: 'var(--c-brand)' },
  normal:   { label: 'Healthy',  color: 'var(--c-charge)' },
  offline:  { label: 'No Data',  color: 'var(--text-4)' },
};

/**
 * Slope of a series in mV / minute using least squares.
 * samples: [{ t: ms, v: volts }]
 */
export function trendMvPerMin(samples) {
  const pts = samples.filter(s => s.v > 1);
  if (pts.length < 4) return 0;
  const t0 = pts[0].t;
  const n = pts.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) {
    const x = (p.t - t0) / 60000; // minutes
    const y = p.v * 1000;         // mV
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return 0;
  return (n * sxy - sx * sy) / denom;
}

export function formatDuration(totalSec = 0) {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
