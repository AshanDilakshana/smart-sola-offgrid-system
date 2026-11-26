import React from 'react';
import { PlugZap, Power, BatteryCharging, Signal } from 'lucide-react';

function rssiQuality(rssi) {
  if (!rssi) return { label: '—', bars: 0 };
  if (rssi >= -55) return { label: 'Excellent', bars: 4 };
  if (rssi >= -67) return { label: 'Good', bars: 3 };
  if (rssi >= -75) return { label: 'Fair', bars: 2 };
  return { label: 'Weak', bars: 1 };
}

function Kpi({ icon, label, value, tone, sub, children, delay }) {
  return (
    <div className={`kpi tone-${tone} reveal`} style={{ '--reveal-delay': `${delay}ms` }}>
      <span className="kpi-icon">{icon}</span>
      <div className="kpi-text">
        <span className="kpi-label">{label}</span>
        <span className="kpi-value">{value}</span>
        {sub && <span className="kpi-sub">{sub}</span>}
      </div>
      {children}
    </div>
  );
}

export default function StatusStrip({ status, connected }) {
  const q = rssiQuality(status?.rssi);
  const grid = !!status?.gridPresent;
  const inv = !!status?.inverterState;
  const smps = !!status?.smpsState;

  return (
    <div className="kpi-strip">
      <Kpi
        delay={0}
        icon={<PlugZap size={18} />}
        label="Main Grid"
        value={!connected ? '—' : grid ? 'Online' : 'Power Cut'}
        tone={!connected ? 'muted' : grid ? 'charge' : 'danger'}
        sub={grid ? '230V AC present' : connected ? 'Running on battery' : 'Awaiting data'}
      />
      <Kpi
        delay={40}
        icon={<Power size={18} />}
        label="Inverter"
        value={!connected ? '—' : inv ? 'Active' : 'Standby'}
        tone={!connected ? 'muted' : inv ? 'inverter' : 'muted'}
        sub={inv ? 'Backup output ON' : 'Relay OFF'}
      />
      <Kpi
        delay={80}
        icon={<BatteryCharging size={18} />}
        label="SMPS Charger"
        value={!connected ? '—' : smps ? 'Charging' : 'Standby'}
        tone={!connected ? 'muted' : smps ? 'brand' : 'muted'}
        sub={status?.forceChargingActive ? 'Force charge override' : smps ? 'Relay ON' : 'Relay OFF'}
      />
      <Kpi
        delay={120}
        icon={<Signal size={18} />}
        label="Wi-Fi Signal"
        value={status?.rssi ? `${status.rssi} dBm` : '—'}
        tone={q.bars >= 3 ? 'charge' : q.bars === 2 ? 'warning' : q.bars === 1 ? 'danger' : 'muted'}
        sub={q.label}
      >
        <span className="signal-bars" aria-hidden="true">
          {[1, 2, 3, 4].map(b => <i key={b} className={b <= q.bars ? 'on' : ''} />)}
        </span>
      </Kpi>
    </div>
  );
}
