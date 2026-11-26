import React, { useId, useMemo } from 'react';
import { BatteryCharging, ChevronsUp, ChevronsDown, Minus, Scale, ArrowUp, ArrowDown, Zap, ZapOff, Activity } from 'lucide-react';
import {
  CELL_COUNT,
  cellSocFromVoltage,
  cellBand,
  BAND_META,
  DIRECTION_META,
  chargeCurrent,
  getFlowDirection,
  trendMvPerMin,
  clamp,
} from '../utils/battery';
import { AnimatedNumber } from '../hooks/useAnimatedNumber';

const TREND_WINDOW = 20;       // samples (~40 s at 2 s polling)
const TREND_THRESHOLD = 3;     // mV/min to call a resting cell rising/falling
const DEV_SCALE_MV = 30;       // full-scale for the deviation bar

function CellSparkline({ points, color }) {
  const uid = useId().replace(/:/g, '');
  const valid = points.filter(v => v > 1);
  if (valid.length < 2) {
    return <div className="cell-spark cell-spark--empty">collecting…</div>;
  }
  const W = 100, H = 26;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const range = Math.max(max - min, 0.004);
  const coords = valid.map((v, i) => {
    const x = (i / (valid.length - 1)) * W;
    const y = H - 2 - ((v - min) / range) * (H - 4);
    return [x, y];
  });
  const line = coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `0,${H} ${line} ${W},${H}`;
  const gid = `spark-${uid}`;
  return (
    <svg className="cell-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.35 }} />
          <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gid})`} />
      <polyline points={line} fill="none" style={{ stroke: color }} strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function CellVisual({ soc, state, color, index }) {
  const isCharging = state === 'charging';
  const isDischarging = state === 'discharging';
  const fillRatio = state === 'offline' ? 0 : clamp(soc, 4, 100) / 100;
  return (
    <div
      className={`cell-visual is-${state}`}
      style={{ '--fill-ratio': fillRatio, '--cell-color': color, '--delay': `${index * 0.35}s` }}
      role="img"
      aria-label={`Cell ${index + 1} at ${soc}% estimated, ${DIRECTION_META[state]?.label}`}
    >
      <div className="cell-cap" />
      <div className="cell-body">
        <div className="cell-ticks">
          <span /><span /><span />
        </div>
        <div className="cell-liquid">
          <svg className="cell-wave" viewBox="0 0 200 20" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 10 Q25 2 50 10 T100 10 T150 10 T200 10 V20 H0 Z" />
          </svg>
          <svg className="cell-wave cell-wave--back" viewBox="0 0 200 20" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 10 Q25 4 50 10 T100 10 T150 10 T200 10 V20 H0 Z" />
          </svg>
        </div>

        {(isCharging || isDischarging) && (
          <div className="cell-particles" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map(i => (
              <span key={i} style={{ '--i': i, '--x': `${18 + ((i * 37) % 64)}%` }} />
            ))}
          </div>
        )}

        <div className="cell-flow-icon" aria-hidden="true">
          {isCharging && <ChevronsUp size={18} />}
          {isDischarging && <ChevronsDown size={18} />}
          {state === 'float' && <Zap size={14} />}
          {state === 'offline' && <ZapOff size={15} />}
        </div>
        <div className="cell-gloss" />
      </div>
    </div>
  );
}

function DeviationBar({ deltaMv }) {
  const pct = clamp(Math.abs(deltaMv) / DEV_SCALE_MV, 0, 1) * 50;
  const positive = deltaMv >= 0;
  return (
    <div className="dev-bar" title={`${deltaMv >= 0 ? '+' : ''}${deltaMv.toFixed(1)} mV from pack average`}>
      <span className="dev-bar-center" />
      <span
        className={`dev-bar-fill ${positive ? 'is-pos' : 'is-neg'}`}
        style={positive ? { left: '50%', width: `${pct}%` } : { right: '50%', width: `${pct}%` }}
      />
    </div>
  );
}

export default function BatteryCells({ cellVoltages, cellHistory = [], rawCurrent = 0, chargerOn = false, connected = false }) {
  const model = useMemo(() => {
    const cells = Array.from({ length: CELL_COUNT }, (_, i) => {
      const v = Array.isArray(cellVoltages) ? Number(cellVoltages[i]) || 0 : 0;
      return connected ? v : 0;
    });
    const valid = cells.filter(v => v > 1);
    const hasData = valid.length > 0;
    const avg = hasData ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
    const maxV = hasData ? Math.max(...valid) : 0;
    const minV = hasData ? Math.min(...valid) : 0;
    const spreadMv = hasData ? (maxV - minV) * 1000 : 0;
    const packDir = hasData ? getFlowDirection(rawCurrent, chargerOn) : 'offline';
    const signedAmps = chargeCurrent(rawCurrent);
    const amps = Math.abs(rawCurrent);
    const recent = cellHistory.slice(-TREND_WINDOW);

    const items = cells.map((v, i) => {
      const series = cellHistory.map(h => h.cells?.[i] ?? 0);
      const trend = trendMvPerMin(recent.map(h => ({ t: h.t, v: h.cells?.[i] ?? 0 })));
      let state;
      if (v <= 1) state = 'offline';
      else if (packDir === 'idle') {
        state = trend > TREND_THRESHOLD ? 'charging' : trend < -TREND_THRESHOLD ? 'discharging' : 'idle';
      } else state = packDir;

      const band = cellBand(v);
      const soc = v > 1 ? cellSocFromVoltage(v) : 0;
      const stateColor = DIRECTION_META[state]?.color;
      const color = band === 'critical' ? BAND_META.critical.color : state === 'idle' ? BAND_META[band].color : stateColor;
      return {
        index: i,
        v,
        soc,
        band,
        state,
        color,
        trend,
        series,
        deltaMv: v > 1 ? (v - avg) * 1000 : 0,
        power: v > 1 ? v * amps : 0,
        isMax: hasData && valid.length > 1 && v === maxV && spreadMv > 0.5,
        isMin: hasData && valid.length > 1 && v === minV && spreadMv > 0.5,
      };
    });

    let balance = { label: 'No Data', tone: 'muted' };
    if (hasData) {
      if (spreadMv < 15) balance = { label: 'Balanced', tone: 'success' };
      else if (spreadMv < 50) balance = { label: 'Minor Drift', tone: 'warning' };
      else balance = { label: 'Imbalanced', tone: 'danger' };
    }

    const maxIdx = items.findIndex(c => c.isMax);
    const minIdx = items.findIndex(c => c.isMin);
    return { items, avg, spreadMv, packDir, signedAmps, balance, hasData, maxV, minV, maxIdx, minIdx };
  }, [cellVoltages, cellHistory, rawCurrent, chargerOn, connected]);

  const dirMeta = DIRECTION_META[model.packDir];
  const signedAmps = model.signedAmps;

  return (
    <section className="card cells-card reveal" style={{ '--reveal-delay': '120ms' }}>
      <header className="cells-head">
        <div className="cells-title">
          <span className="icon-tile icon-tile--brand"><BatteryCharging size={18} /></span>
          <div>
            <h2>Cell Monitor</h2>
            <p>4S LiFePO4 · JK BMS · per-cell live telemetry</p>
          </div>
        </div>

        <div className={`flow-pill is-${model.packDir}`}>
          <span className="flow-pill-icon">
            {model.packDir === 'charging' && <ArrowUp size={13} />}
            {model.packDir === 'discharging' && <ArrowDown size={13} />}
            {model.packDir === 'float' && <Zap size={13} />}
            {(model.packDir === 'idle' || model.packDir === 'offline') && <Minus size={13} />}
          </span>
          Pack {dirMeta.label}
        </div>
      </header>

      <div className="cells-stats">
        <div className="stat">
          <span className="stat-label">Average</span>
          <span className="stat-value mono">{model.hasData ? <AnimatedNumber value={model.avg} decimals={3} /> : '—'}<small>V</small></span>
        </div>
        <div className="stat">
          <span className="stat-label">Spread ΔV</span>
          <span className="stat-value mono">{model.hasData ? <AnimatedNumber value={model.spreadMv} decimals={0} /> : '—'}<small>mV</small></span>
        </div>
        <div className="stat">
          <span className="stat-label">Highest</span>
          <span className="stat-value mono">{model.maxIdx >= 0 ? `C${model.maxIdx + 1}` : '—'}<small>{model.hasData ? model.maxV.toFixed(3) : ''}</small></span>
        </div>
        <div className="stat">
          <span className="stat-label">Lowest</span>
          <span className="stat-value mono">{model.minIdx >= 0 ? `C${model.minIdx + 1}` : '—'}<small>{model.hasData ? model.minV.toFixed(3) : ''}</small></span>
        </div>
        <div className="stat stat--badge">
          <span className="stat-label">Balance</span>
          <span className={`chip chip--${model.balance.tone}`}><Scale size={12} /> {model.balance.label}</span>
        </div>
      </div>

      <div className="cells-grid">
        {model.items.map(cell => {
          const meta = DIRECTION_META[cell.state];
          return (
            <article
              key={cell.index}
              className={`cell-card is-${cell.state} band-${cell.band}`}
              style={{ '--cell-color': cell.color, '--stagger': `${cell.index * 70}ms` }}
            >
              <div className="cell-card-top">
                <div className="cell-id-wrap">
                  <span className="cell-id mono">CELL&nbsp;{String(cell.index + 1).padStart(2, '0')}</span>
                  {(cell.isMax || cell.isMin || cell.band === 'critical') && (
                    <div className="cell-tags">
                      {cell.isMax && <span className="tag tag--hi">HIGH</span>}
                      {cell.isMin && <span className="tag tag--lo">LOW</span>}
                      {cell.band === 'critical' && <span className="tag tag--crit">CHECK</span>}
                    </div>
                  )}
                </div>
                <span className={`cell-state is-${cell.state}`}>
                  <span className="cell-state-dot" />
                  {cell.state === 'charging' && <ArrowUp size={11} />}
                  {cell.state === 'discharging' && <ArrowDown size={11} />}
                  {cell.state === 'float' && <Zap size={11} />}
                  {(cell.state === 'idle' || cell.state === 'offline') && <Minus size={11} />}
                  {meta.label}
                </span>
              </div>

              <div className="cell-card-main">
                <CellVisual soc={cell.soc} state={cell.state} color={cell.color} index={cell.index} />

                <div className="cell-readout">
                  <div className="cell-volt mono">
                    {cell.v > 1 ? <AnimatedNumber value={cell.v} decimals={3} /> : '—.———'}
                    <small>V</small>
                  </div>
                  <div className="cell-soc">
                    <span className="mono">{cell.v > 1 ? `${cell.soc}%` : '—'}</span> est. SOC
                  </div>

                  <dl className="cell-metrics">
                    <div>
                      <dt>
                        {cell.state === 'charging' && <ArrowUp size={11} />}
                        {cell.state === 'discharging' && <ArrowDown size={11} />}
                        {(cell.state !== 'charging' && cell.state !== 'discharging') && <Minus size={11} />}
                        {' '}Current
                      </dt>
                      <dd className={`mono ${cell.state === 'charging' ? 'up' : cell.state === 'discharging' ? 'down' : ''}`}>
                        {cell.v > 1
                          ? `${signedAmps > 0.05 ? '+' : signedAmps < -0.05 ? '−' : ''}${Math.abs(signedAmps).toFixed(1)}`
                          : '—'}
                        <small>A</small>
                      </dd>
                    </div>
                    <div>
                      <dt><Zap size={11} /> Power</dt>
                      <dd className="mono">{cell.v > 1 ? cell.power.toFixed(1) : '—'}<small>W</small></dd>
                    </div>
                    <div>
                      <dt><Activity size={11} /> Trend</dt>
                      <dd className={`mono ${cell.trend > 0.5 ? 'up' : cell.trend < -0.5 ? 'down' : ''}`}>
                        {cell.v > 1 ? `${cell.trend >= 0 ? '+' : ''}${cell.trend.toFixed(1)}` : '—'}
                        <small>mV/m</small>
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>

              <div className={`cell-flow-bar is-${cell.state}`} aria-hidden="true">
                <div className="cell-flow-bar-fill" style={{ width: `${cell.v > 1 ? clamp(cell.soc, 4, 100) : 0}%` }} />
              </div>

              <div className="cell-dev">
                <div className="cell-dev-head">
                  <span>Δ vs avg</span>
                  <span className="mono">{cell.v > 1 ? `${cell.deltaMv >= 0 ? '+' : ''}${cell.deltaMv.toFixed(1)} mV` : '—'}</span>
                </div>
                <DeviationBar deltaMv={cell.deltaMv} />
              </div>

              <CellSparkline points={cell.series} color={cell.color} />
            </article>
          );
        })}
      </div>

      <footer className="cells-foot">
        <span>Series pack: every cell carries the same pack current. Per-cell trend comes from the last ~40 s of voltage samples.</span>
        <span className="cells-legend">
          <i style={{ background: 'var(--c-charge)' }} /> Charging
          <i style={{ background: 'var(--c-discharge)' }} /> Discharging
          <i style={{ background: 'var(--c-brand)' }} /> Float
          <i style={{ background: 'var(--text-3)' }} /> Idle
        </span>
      </footer>
    </section>
  );
}
