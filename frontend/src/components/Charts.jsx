import React, { useId, useMemo, useRef, useState } from 'react';
import { TrendingUp, Clock3 } from 'lucide-react';
import { chargeCurrent } from '../utils/battery';

export const CHART_RANGES = [
  { id: 'live', label: 'Live' },
  { id: '1d', label: '1D' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: '60d', label: '60D' },
];

/** Catmull-Rom → cubic Bézier for a smooth line through <=120 points. */
function smoothPath(pts) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const t = 0.18;
    const c1x = p1[0] + (p2[0] - p0[0]) * t;
    const c1y = p1[1] + (p2[1] - p0[1]) * t;
    const c2x = p2[0] - (p3[0] - p1[0]) * t;
    const c2y = p2[1] - (p3[1] - p1[1]) * t;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}

/** Crisp polyline path for dense multi-day trends (>120 points) without overshoot. */
function linearPath(pts) {
  if (pts.length < 2) return '';
  return pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
}

function formatAxisTick(epoch, range) {
  if (!epoch) return '';
  const d = new Date(epoch * 1000);
  if (range === 'live') {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  if (range === '1d') {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTooltipDate(pt, range) {
  if (pt.epoch) {
    const d = new Date(pt.epoch * 1000);
    if (range === 'live' || range === '1d') {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: range === 'live' ? '2-digit' : undefined, hour12: false });
    }
    const dayStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    return `${dayStr}, ${timeStr}`;
  }
  return pt.time || '';
}

function formatTooltipMeta(pt) {
  const parts = [];
  if (Number.isFinite(pt.soc) && pt.soc > 0) {
    parts.push(`${Math.round(pt.soc)}%`);
  }
  if (Number.isFinite(pt.current)) {
    const signed = chargeCurrent(pt.current);
    const absA = Math.abs(signed).toFixed(1);
    if (signed > 0.05 || pt.phase === 'charging') parts.push(`Charging ${absA}A`);
    else if (signed < -0.05 || pt.phase === 'discharging') parts.push(`Discharging ${absA}A`);
    else parts.push('Idle');
  } else if (pt.phase) {
    parts.push(pt.phase.charAt(0).toUpperCase() + pt.phase.slice(1));
  }
  return parts.join(' · ');
}

export function VoltageChart({ points = [], range = '1d', loading = false }) {
  const uid = useId().replace(/:/g, '');
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null);
  const W = 640, H = 190, padL = 44, padR = 14, padT = 14, padB = 24;

  const normalized = useMemo(() => {
    return (points || [])
      .map((p) => {
        const volt = Number(p?.batteryVoltage ?? p?.volt ?? 0);
        const epoch = Number(p?.epoch) || 0;
        const current = p?.batteryCurrent !== undefined ? Number(p.batteryCurrent) : undefined;
        const soc = p?.batterySoc !== undefined ? Number(p.batterySoc) : undefined;
        return {
          epoch,
          volt,
          current,
          soc,
          phase: p?.phase,
          time: p?.time || (epoch ? new Date(epoch * 1000).toLocaleTimeString() : ''),
        };
      })
      .filter((p) => Number.isFinite(p.volt) && p.volt > 0)
      .sort((a, b) => (a.epoch && b.epoch ? a.epoch - b.epoch : 0));
  }, [points]);

  const chart = useMemo(() => {
    if (normalized.length < 2) return null;
    const volts = normalized.map((h) => h.volt);
    const rawMin = Math.min(...volts);
    const rawMax = Math.max(...volts);
    const avgV = volts.reduce((a, b) => a + b, 0) / volts.length;

    const minV = rawMin - 0.15;
    const maxV = rawMax + 0.15;
    const rangeV = maxV - minV || 1;
    const cw = W - padL - padR;
    const ch = H - padT - padB;

    const firstEpoch = normalized[0].epoch;
    const lastEpoch = normalized[normalized.length - 1].epoch;
    const useEpochScale = firstEpoch > 0 && lastEpoch > firstEpoch;
    const epochSpan = lastEpoch - firstEpoch || 1;

    const pts = normalized.map((h, i) => {
      const fracX = useEpochScale ? (h.epoch - firstEpoch) / epochSpan : i / (normalized.length - 1);
      const x = padL + fracX * cw;
      const y = padT + ch - ((h.volt - minV) / rangeV) * ch;
      return [x, y];
    });

    const line = pts.length > 120 ? linearPath(pts) : smoothPath(pts);
    const area = `${line} L${pts[pts.length - 1][0].toFixed(2)},${padT + ch} L${pts[0][0].toFixed(2)},${padT + ch} Z`;

    const grid = Array.from({ length: 5 }, (_, i) => ({
      y: padT + (i / 4) * ch,
      label: (maxV - (i / 4) * rangeV).toFixed(2),
    }));

    // 12.5V reference threshold line when inside visible Y bounds
    const thresholdY = 12.5 >= minV && 12.5 <= maxV
      ? padT + ch - ((12.5 - minV) / rangeV) * ch
      : null;

    // 5 evenly spaced X-axis time labels
    const xTicks = [];
    const tickCount = 5;
    for (let i = 0; i < tickCount; i++) {
      const frac = i / (tickCount - 1);
      const x = padL + frac * cw;
      let label = '';
      if (useEpochScale) {
        const tickEpoch = Math.round(firstEpoch + frac * epochSpan);
        label = formatAxisTick(tickEpoch, range);
      } else {
        const idx = Math.round(frac * (normalized.length - 1));
        label = normalized[idx]?.time || '';
      }
      xTicks.push({
        x,
        label,
        anchor: i === 0 ? 'start' : i === tickCount - 1 ? 'end' : 'middle',
      });
    }

    return {
      pts,
      line,
      area,
      grid,
      xTicks,
      thresholdY,
      cw,
      ch,
      stats: { minV: rawMin, avgV, maxV: rawMax, count: normalized.length },
    };
  }, [normalized, range]);

  if (!chart) {
    if (loading) {
      return (
        <div className="chart-empty">
          <span className="loader-dots"><i /><i /><i /></span>
          Loading {range.toUpperCase()} voltage telemetry…
        </div>
      );
    }
    return (
      <div className="chart-empty">
        <span>
          {range === 'live'
            ? 'Streaming live telemetry…'
            : `No voltage history recorded for ${range.toUpperCase()} yet.`}
        </span>
      </div>
    );
  }

  const onMove = (e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;

    // Nearest point lookup by X coordinate (handles variable adaptive 2m-15m spacing)
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < chart.pts.length; i++) {
      const d = Math.abs(chart.pts[i][0] - x);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    setHover(bestIdx);
  };

  const safeHover = hover !== null && hover < normalized.length ? hover : null;
  const last = chart.pts[chart.pts.length - 1];
  const hp = safeHover !== null ? chart.pts[safeHover] : null;
  const hoverItem = safeHover !== null ? normalized[safeHover] : null;
  const hoverMeta = hoverItem ? formatTooltipMeta(hoverItem) : '';

  return (
    <div className="chart-body">
      <div className="chart-stats mono">
        <span>Min <strong>{chart.stats.minV.toFixed(2)}V</strong></span>
        <span>Avg <strong>{chart.stats.avgV.toFixed(2)}V</strong></span>
        <span>Max <strong>{chart.stats.maxV.toFixed(2)}V</strong></span>
        <span className="chart-stats-count">{chart.stats.count} pts</span>
      </div>

      <div className="chart-wrap">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="line-chart"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          onTouchMove={(e) => e.touches[0] && onMove(e.touches[0])}
          onTouchEnd={() => setHover(null)}
        >
          <defs>
            <linearGradient id={`vArea-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`vLine-${uid}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#3b82f6" />
              <stop offset="100%" stopColor="#22d3ee" />
            </linearGradient>
          </defs>

          {chart.grid.map((g, i) => (
            <g key={i}>
              <line x1={padL} y1={g.y} x2={W - padR} y2={g.y} className="grid-line" />
              <text x={padL - 8} y={g.y + 3} className="axis-label" textAnchor="end">{g.label}</text>
            </g>
          ))}

          {chart.thresholdY !== null && (
            <g>
              <line x1={padL} y1={chart.thresholdY} x2={W - padR} y2={chart.thresholdY} className="threshold-line" />
              <text x={W - padR - 2} y={chart.thresholdY - 4} className="threshold-label" textAnchor="end">12.5V</text>
            </g>
          )}

          {chart.xTicks.map((t, i) => (
            <text key={i} x={t.x} y={H - 5} className="axis-label" textAnchor={t.anchor}>{t.label}</text>
          ))}

          <path d={chart.area} fill={`url(#vArea-${uid})`} className="chart-area" />
          <path d={chart.line} fill="none" stroke={`url(#vLine-${uid})`} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" className="chart-line" />
          <circle cx={last[0]} cy={last[1]} r="8" className="chart-pulse" />
          <circle cx={last[0]} cy={last[1]} r="3.5" className="chart-dot" />

          {hp && (
            <g className="chart-hover">
              <line x1={hp[0]} y1={padT} x2={hp[0]} y2={H - padB} />
              <circle cx={hp[0]} cy={hp[1]} r="4" />
            </g>
          )}
        </svg>

        {hp && hoverItem && (
          <div
            className="chart-tooltip mono"
            style={{ left: `${Math.min(86, Math.max(14, (hp[0] / W) * 100))}%`, top: `${(hp[1] / H) * 100}%` }}
          >
            <strong>{hoverItem.volt.toFixed(2)} V</strong>
            <span>{formatTooltipDate(hoverItem, range)}</span>
            {hoverMeta && <span className="chart-tooltip-meta">{hoverMeta}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export function UptimeChart({ days = [] }) {
  if (!days.length) {
    return (
      <div className="chart-empty">
        <span className="loader-dots"><i /><i /><i /></span>
        Loading history…
      </div>
    );
  }
  return (
    <div className="bars">
      {days.map((day, idx) => {
        const hours = day.uptimeHours !== undefined ? Number(day.uptimeHours) : ((day.uptimeChunks || 0) * 15) / 60;
        const h = Math.min(100, (hours / 24) * 100);
        const danger = day.deepDischargeCount > 0;
        const vRange = day.minVoltage && day.maxVoltage ? ` · ${day.minVoltage}–${day.maxVoltage}V` : '';
        const ddNote = danger ? ` · ${day.deepDischargeCount} deep discharge(s)` : '';
        return (
          <div key={day.dateKey || day.dateStr || idx} className="bar" title={`${day.dateStr}: ${hours.toFixed(1)} h${vRange}${ddNote}`}>
            <div className="bar-track">
              <div className={`bar-fill ${danger ? 'is-danger' : ''}`} style={{ height: `${Math.max(h, 2)}%`, '--i': idx }}>
                <span className="bar-val mono">{hours > 0 ? `${hours.toFixed(1)}h` : ''}</span>
              </div>
              {danger && <span className="bar-flag">!</span>}
            </div>
            <span className="bar-label">{day.shortDay}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function ChartsSection({
  history = [],
  trendHistory = [],
  chartRange = '1d',
  onChartRangeChange,
  trendLoading = false,
  dailyHistory = [],
}) {
  const voltagePoints = useMemo(() => {
    if (chartRange === 'live') return history;
    const base = Array.isArray(trendHistory) ? trendHistory : [];
    const lastDbEpoch = base.length ? Number(base[base.length - 1].epoch || 0) : 0;

    if (chartRange === '1d') {
      const newerLive = history.filter((h) => Number(h.epoch || 0) > lastDbEpoch);
      return [...base, ...newerLive];
    }

    if (history.length > 0) {
      const latest = history[history.length - 1];
      if (Number(latest.epoch || 0) > lastDbEpoch) {
        return [...base, latest];
      }
    }
    return base;
  }, [chartRange, history, trendHistory]);

  return (
    <div className="charts-grid">
      <section className="card reveal" style={{ '--reveal-delay': '260ms' }}>
        <header className="card-head">
          <div className="card-title">
            <span className="icon-tile icon-tile--brand"><TrendingUp size={16} /></span>
            <div>
              <h2>Pack Voltage Trend</h2>
              <p>
                {chartRange === 'live'
                  ? 'Live 2 s telemetry stream'
                  : `Past ${chartRange.toUpperCase()} MongoDB trend · adaptive 2m–15m`}
              </p>
            </div>
          </div>

          <div className="chart-head-actions">
            <div className="chart-range-tabs" role="tablist" aria-label="Voltage trend range">
              {CHART_RANGES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="tab"
                  aria-selected={chartRange === r.id}
                  className={chartRange === r.id ? 'is-on' : ''}
                  onClick={() => onChartRangeChange?.(r.id)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </header>

        <VoltageChart points={voltagePoints} range={chartRange} loading={trendLoading} />
      </section>

      <section className="card reveal" style={{ '--reveal-delay': '300ms' }}>
        <header className="card-head">
          <div className="card-title">
            <span className="icon-tile icon-tile--violet"><Clock3 size={16} /></span>
            <div>
              <h2>Inverter Uptime</h2>
              <p>Last 7 days · MongoDB snapshots</p>
            </div>
          </div>
          <span className="chip chip--danger-soft"><b>!</b> Deep discharge</span>
        </header>
        <UptimeChart days={dailyHistory} />
      </section>
    </div>
  );
}
