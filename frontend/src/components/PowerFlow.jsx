import React from 'react';
import { PlugZap, BatteryCharging, Battery, Power, Zap, Home, ChevronRight } from 'lucide-react';
import { formatDuration } from '../utils/battery';

function Stream({ active, tone, speed = '1.4s', reverse = false }) {
  return (
    <div
      className={`stream ${active ? `is-active tone-${tone}` : ''} ${reverse ? 'is-reverse' : ''}`}
      style={{ '--flow-speed': speed }}
      aria-hidden="true"
    >
      <div className="stream-line" />
      <span className="stream-arrow">
        <ChevronRight size={13} />
      </span>
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
  const amps = Math.abs(rawCurrent);
  const watts = Math.round(batVolt * amps);

  const chargingFlow = connected && (smps || direction === 'charging');
  const gridToSmps = connected && grid && smps;
  const invSupply = connected && inv;
  const gridBypass = connected && grid && !inv;
  const flowSpeed = `${Math.max(0.85, Math.min(1.75, 1.65 - (amps / 20) * 0.75)).toFixed(2)}s`;

  let routeChip;
  if (!connected) routeChip = { label: 'Offline', tone: 'muted' };
  else if (invSupply && chargingFlow) routeChip = { label: 'Hybrid · Charge + Inverter', tone: 'violet' };
  else if (invSupply) routeChip = { label: 'Battery → Inverter → Home', tone: 'violet' };
  else if (chargingFlow && gridBypass) routeChip = { label: 'Grid → SMPS + Home', tone: 'brand' };
  else if (chargingFlow) routeChip = { label: 'SMPS → Battery Charging', tone: 'success' };
  else if (gridBypass) routeChip = { label: 'Grid → Home Direct', tone: 'success' };
  else routeChip = { label: 'AC Output Off', tone: 'danger' };

  const bypassLabel = !connected
    ? 'STANDBY'
    : gridBypass
      ? 'GRID BYPASS · 230V DIRECT'
      : invSupply
        ? 'ATS ISOLATED · INVERTER SUPPLY'
        : 'GRID DOWN · NO BYPASS';

  return (
    <section className="card flow-card reveal" style={{ '--reveal-delay': '180ms' }}>
      <header className="card-head">
        <div className="card-title">
          <span className="icon-tile icon-tile--brand"><Zap size={16} /></span>
          <div>
            <h2>Energy Flow</h2>
            <p>Real-time ATS power routing topology</p>
          </div>
        </div>
        <div className="flow-head-chips">
          <span className={`chip chip--${routeChip.tone}`}>{routeChip.label}</span>
          <span className="chip chip--brand mono">MODE · {status?.modeString || 'POWER OFF'}</span>
        </div>
      </header>

      <div className="flow-diagram">
        <div className={`flow-bypass ${gridBypass ? 'is-active tone-charge' : invSupply ? 'is-inverter' : ''}`}>
          <div className="flow-bypass-rail" aria-hidden="true" />
          {gridBypass && (
            <div className="flow-bypass-particles" aria-hidden="true">
              <span /><span /><span />
            </div>
          )}
          <span className="flow-bypass-badge mono">{bypassLabel}</span>
        </div>

        <div className="flow-pipeline">
          <Node
            icon={<PlugZap size={20} />}
            title="Main Grid"
            sub={grid ? '230V AC online' : 'Grid down'}
            state={!connected ? 'off' : grid ? 'ok' : 'down'}
          />
          <Stream active={gridToSmps} tone="brand" speed={flowSpeed} />
          <Node
            icon={<BatteryCharging size={20} />}
            title="SMPS Charger"
            sub={smps ? 'Charging' : 'Standby'}
            state={connected && smps ? 'brand' : 'off'}
            pulse={connected && smps}
          />
          <Stream active={chargingFlow} tone="charge" speed={flowSpeed} />
          <Node
            icon={<Battery size={20} />}
            title={`Battery ${connected ? `${soc}%` : ''}`}
            sub={connected ? `${batVolt.toFixed(2)}V · ${watts}W` : 'No data'}
            state={!connected ? 'off' : direction === 'charging' ? 'charge' : direction === 'discharging' ? 'discharge' : 'battery'}
            pulse={connected && (direction === 'charging' || direction === 'discharging')}
          />
          <Stream active={invSupply} tone="discharge" speed={flowSpeed} />
          <Node
            icon={<Power size={20} />}
            title="Inverter"
            sub={inv ? `ON · ${formatDuration(inverterOnTime)}` : 'Relay off'}
            state={invSupply ? 'inverter' : 'off'}
            pulse={invSupply}
          />
          <Stream active={invSupply} tone="inverter" speed={flowSpeed} />
          <Node
            icon={<Home size={20} />}
            title="Home Load"
            sub={!connected ? 'No data' : invSupply ? `Inverter AC · ${watts}W` : gridBypass ? 'Grid Direct · 230V' : 'No AC Output'}
            state={!connected ? 'off' : invSupply ? 'inverter' : gridBypass ? 'ok' : 'down'}
            pulse={invSupply}
          />
        </div>
      </div>
    </section>
  );
}
