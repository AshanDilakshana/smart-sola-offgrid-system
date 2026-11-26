import React, { useId } from 'react';
import { Battery, Zap, Timer, RefreshCw, ArrowUp, ArrowDown, Minus, ShieldCheck } from 'lucide-react';
import { AnimatedNumber } from '../hooks/useAnimatedNumber';
import { DIRECTION_META, chargeCurrent, formatDuration, clamp } from '../utils/battery';

const R = 80;
const C = 2 * Math.PI * R;
const ARC = C * 0.75;

const TONES = {
  charge:    ['#34d399', '#10b981'],
  discharge: ['#fbbf24', '#f97316'],
  brand:     ['#22d3ee', '#3b82f6'],
  danger:    ['#f87171', '#ef4444'],
  warn:      ['#facc15', '#f59e0b'],
  muted:     ['#475569', '#334155'],
};

function RingGauge({ fraction, tone = 'brand', children, active = false, label }) {
  const uid = useId().replace(/:/g, '');
  const [c1, c2] = TONES[tone] || TONES.brand;
  const offset = ARC - clamp(fraction, 0, 1) * ARC;
  const ticks = Array.from({ length: 28 }, (_, i) => i);

  return (
    <div className={`ring ${active ? 'is-active' : ''}`} style={{ '--ring-glow': c1 }} aria-label={label}>
      <svg viewBox="0 0 200 200">
        <defs>
          <linearGradient id={`g-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={c1} />
            <stop offset="100%" stopColor={c2} />
          </linearGradient>
        </defs>
        {/* tick marks */}
        <g transform="rotate(135 100 100)">
          {ticks.map(i => {
            const a = (i / (ticks.length - 1)) * 270 * (Math.PI / 180);
            const r1 = 95, r2 = i % 3 === 0 ? 89 : 92;
            return (
              <line
                key={i}
                x1={100 + r1 * Math.cos(a)} y1={100 + r1 * Math.sin(a)}
                x2={100 + r2 * Math.cos(a)} y2={100 + r2 * Math.sin(a)}
                className="ring-tick"
              />
            );
          })}
        </g>
        <circle cx="100" cy="100" r={R} className="ring-track" strokeDasharray={`${ARC} ${C}`} transform="rotate(135 100 100)" />
        <circle
          cx="100" cy="100" r={R}
          className="ring-value"
          stroke={`url(#g-${uid})`}
          strokeDasharray={`${ARC} ${C}`}
          strokeDashoffset={offset}
          transform="rotate(135 100 100)"
        />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

export default function BatteryHero({ status, batVolt, rawCurrent, soc, direction, inverterOnTime, connected }) {
  const meta = DIRECTION_META[connected ? direction : 'offline'];
  const amps = Math.abs(rawCurrent);
  const watts = batVolt * amps;
  const signed = chargeCurrent(rawCurrent);

  const socTone = !connected ? 'muted' : soc > 60 ? 'charge' : soc > 30 ? 'warn' : 'danger';
  const ampTone = !connected ? 'muted' : direction === 'charging' ? 'charge' : direction === 'discharging' ? 'discharge' : 'brand';

  return (
    <section className={`card hero is-${connected ? direction : 'offline'} reveal`} style={{ '--reveal-delay': '60ms' }}>
      <div className="hero-glow" aria-hidden="true" />

      <div className="hero-info">
        <div className="eyebrow">
          <Battery size={14} /> Battery Pack · 12.8V LiFePO4
        </div>

        <div className="hero-volt mono">
          <AnimatedNumber value={connected ? batVolt : 0} decimals={2} />
          <span className="unit">V</span>
        </div>

        <div className="hero-status-row">
          <span className={`flow-pill is-${connected ? direction : 'offline'}`}>
            <span className="flow-pill-icon">
              {direction === 'charging' && connected && <ArrowUp size={13} />}
              {direction === 'discharging' && connected && <ArrowDown size={13} />}
              {direction === 'float' && connected && <Zap size={13} />}
              {(direction === 'idle' || !connected) && <Minus size={13} />}
            </span>
            {meta.label}
          </span>
          {status?.smpsState && (
            <span className="chip chip--brand"><RefreshCw size={11} className="spin" /> SMPS Active</span>
          )}
          {status?.forceChargingActive && <span className="chip chip--warning">Force Charge ON</span>}
          {status?.flatlineDetected && <span className="chip chip--success"><ShieldCheck size={11} /> dV/dt Full Cutoff</span>}
        </div>

        {/* SOC segmented bar */}
        <div className="soc-bar" aria-label={`State of charge ${soc}%`}>
          <div className="soc-bar-head">
            <span>State of Charge</span>
            <span className="mono">{connected ? `${soc}%` : '—'}</span>
          </div>
          <div className="soc-track">
            <div className={`soc-fill tone-${socTone} ${connected && direction === 'charging' ? 'is-charging' : connected && direction === 'discharging' ? 'is-discharging' : ''}`} style={{ width: `${connected ? soc : 0}%` }} />
            <div className="soc-segments">{Array.from({ length: 20 }, (_, i) => <span key={i} />)}</div>
          </div>
        </div>

        <div className="hero-metrics">
          <div className="metric">
            <span className="metric-label"><Zap size={12} /> Live Power</span>
            <span className="metric-value mono"><AnimatedNumber value={connected ? watts : 0} decimals={0} /><small>W</small></span>
            <span className="metric-sub" style={{ color: meta.color }}>{connected ? meta.label : 'Offline'}</span>
          </div>
          <div className="metric">
            <span className="metric-label">
              {connected && signed > 0.05 ? <ArrowUp size={12} style={{ color: 'var(--c-charge)' }} /> : connected && signed < -0.05 ? <ArrowDown size={12} style={{ color: 'var(--c-discharge)' }} /> : <Minus size={12} />} Current
            </span>
            <span className="metric-value mono">
              {connected && signed > 0.05 ? '+' : connected && signed < -0.05 ? '−' : ''}
              <AnimatedNumber value={connected ? amps : 0} decimals={1} /><small>A</small>
            </span>
            <span className="metric-sub">{connected ? (signed > 0.05 ? 'Into battery' : signed < -0.05 ? 'Out of battery' : 'No net flow') : '—'}</span>
          </div>
          <div className="metric">
            <span className="metric-label"><Timer size={12} /> Inverter Uptime</span>
            <span className="metric-value mono metric-value--sm">{formatDuration(inverterOnTime)}</span>
            <span className="metric-sub" style={{ color: status?.inverterState ? 'var(--c-inverter)' : undefined }}>
              {status?.inverterState ? 'Backup running' : 'Standby'}
            </span>
          </div>
        </div>
      </div>

      <div className="hero-gauges">
        <RingGauge fraction={connected ? soc / 100 : 0} tone={socTone} active={connected && direction === 'charging'} label="State of charge gauge">
          <div className="ring-value-text mono"><AnimatedNumber value={connected ? soc : 0} /><span>%</span></div>
          <div className="ring-sub">SOC</div>
        </RingGauge>
        <RingGauge fraction={connected ? amps / 30 : 0} tone={ampTone} active={connected && direction !== 'idle'} label="Current gauge">
          <div className="ring-value-text mono"><AnimatedNumber value={connected ? amps : 0} decimals={1} /><span>A</span></div>
          <div className="ring-sub" style={{ color: connected ? meta.color : undefined }}>{connected ? meta.label : 'No data'}</div>
        </RingGauge>
      </div>
    </section>
  );
}
