import React from 'react';
import { PlugZap, BatteryCharging, Battery, Power, Zap } from 'lucide-react';
import { formatDuration } from '../utils/battery';

function Stream({ active, tone, reverse = false }) {
  return (
    <div className={`stream ${active ? `is-active tone-${tone}` : ''} ${reverse ? 'is-reverse' : ''}`} aria-hidden="true">
      <div className="stream-line" />
      {active && (
        <div className="stream-particles">
          <span /><span /><span />
        </div>
      )}
    </div>
  );
}

function Node({ icon, title, sub, state, pulse }) {
  return (
    <div className={`flow-node is-${state} ${pulse ? 'is-pulsing' : ''}`}>
      <span className="flow-node-icon">{icon}</span>
      <div className="flow-node-text">
        <span className="flow-node-title">{title}</span>
        <span className="flow-node-sub mono">{sub}</span>
      </div>
    </div>
  );
}

export default function PowerFlow({ status, soc, batVolt, rawCurrent, direction, inverterOnTime, connected }) {
  const grid = !!status?.gridPresent;
  const smps = !!status?.smpsState;
  const inv = !!status?.inverterState;
  const watts = Math.round(batVolt * Math.abs(rawCurrent));

  return (
    <section className="card flow-card reveal" style={{ '--reveal-delay': '180ms' }}>
      <header className="card-head">
        <div className="card-title">
          <span className="icon-tile icon-tile--brand"><Zap size={16} /></span>
          <div>
            <h2>Energy Flow</h2>
            <p>Real-time power routing</p>
          </div>
        </div>
        <span className="chip chip--brand mono">MODE · {status?.modeString || 'POWER OFF'}</span>
      </header>

      <div className="flow-pipeline">
        <Node
          icon={<PlugZap size={20} />}
          title="Main Grid"
          sub={grid ? '230V AC online' : 'Grid down'}
          state={!connected ? 'off' : grid ? 'ok' : 'down'}
        />
        <Stream active={connected && grid && smps} tone="brand" />
        <Node
          icon={<BatteryCharging size={20} />}
          title="SMPS Charger"
          sub={smps ? 'Charging' : 'Standby'}
          state={connected && smps ? 'brand' : 'off'}
          pulse={connected && smps}
        />
        <Stream active={connected && smps} tone="charge" />
        <Node
          icon={<Battery size={20} />}
          title={`Battery ${connected ? `${soc}%` : ''}`}
          sub={connected ? `${batVolt.toFixed(2)}V · ${watts}W` : 'No data'}
          state={!connected ? 'off' : direction === 'charging' ? 'charge' : direction === 'discharging' ? 'discharge' : 'battery'}
        />
        <Stream active={connected && inv} tone="inverter" />
        <Node
          icon={<Power size={20} />}
          title="Inverter"
          sub={inv ? `ON · ${formatDuration(inverterOnTime)}` : 'Relay off'}
          state={connected && inv ? 'inverter' : 'off'}
          pulse={connected && inv}
        />
      </div>
    </section>
  );
}
