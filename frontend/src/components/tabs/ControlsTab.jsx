import React from 'react';
import { Sliders, RefreshCw, Zap, ShieldAlert, Activity, Power, Info, Check } from 'lucide-react';

export const MODES = [
  { val: -1, label: 'AUTO',       sub: 'Physical enclosure switches', icon: RefreshCw,   tone: 'brand' },
  { val: 1,  label: 'ECO',        sub: 'Battery priority',            icon: Zap,         tone: 'charge' },
  { val: 2,  label: 'POWER CUT',  sub: 'UPS backup mode',             icon: ShieldAlert, tone: 'warning' },
  { val: 3,  label: 'ECO + PCUT', sub: 'Smart hybrid mode',           icon: Activity,    tone: 'blue' },
  { val: 4,  label: 'MANUAL',     sub: 'Direct relay control',        icon: Power,       tone: 'inverter' },
  { val: 0,  label: 'POWER OFF',  sub: 'Inverter shutdown',           icon: Power,       tone: 'danger' },
];

function Switch({ on, onClick, label, sub, tone = 'charge', disabled }) {
  return (
    <button className={`switch-row ${on ? 'is-on' : ''} tone-${tone}`} onClick={onClick} disabled={disabled} role="switch" aria-checked={on}>
      <div className="switch-text">
        <span className="switch-label">{label}</span>
        <span className="switch-sub">{sub}</span>
      </div>
      <span className="switch"><span className="switch-thumb" /></span>
    </button>
  );
}

export default function ControlsTab({ status, loading, onModeChange, onForceCharge, onRelayToggle }) {
  const manual = status?.webModeOverride === 4;
  return (
    <div className="tab-panel controls-grid">
      <section className="card reveal">
        <header className="card-head">
          <div className="card-title">
            <span className="icon-tile icon-tile--brand"><Sliders size={16} /></span>
            <div>
              <h2>Operating Mode</h2>
              <p>Pushed instantly to the ESP32 over MQTT</p>
            </div>
          </div>
        </header>

        <div className="mode-grid">
          {MODES.map((m, i) => {
            const Icon = m.icon;
            const active = status?.webModeOverride === m.val;
            return (
              <button
                key={m.val}
                className={`mode-btn tone-${m.tone} ${active ? 'is-active' : ''}`}
                onClick={() => !active && onModeChange(m.val)}
                disabled={loading}
                style={{ '--stagger': `${i * 40}ms` }}
                aria-pressed={active}
              >
                <span className="mode-icon"><Icon size={20} /></span>
                <span className="mode-label">{m.label}</span>
                <span className="mode-sub">{m.sub}</span>
                {active && <span className="mode-check"><Check size={12} strokeWidth={3} /></span>}
              </button>
            );
          })}
        </div>

        <p className="note">
          <Info size={14} /> Flipping any physical switch on the ESP32 enclosure restores AUTO hardware control when offline.
        </p>
      </section>

      <section className="card reveal" style={{ '--reveal-delay': '80ms' }}>
        <header className="card-head">
          <div className="card-title">
            <span className="icon-tile icon-tile--warning"><Zap size={16} /></span>
            <div>
              <h2>Charger & Relay Overrides</h2>
              <p>Force the SMPS charger or drive relays in MANUAL mode</p>
            </div>
          </div>
        </header>

        <button
          className={`btn btn--lg btn--block ${status?.forceChargingActive ? 'btn--danger is-live' : 'btn--success'}`}
          onClick={onForceCharge}
          disabled={loading}
        >
          <Zap size={18} />
          {status?.forceChargingActive ? 'Stop Force Charge' : 'Activate Force Charge'}
        </button>

        <div className="switch-list">
          <Switch
            on={!!status?.inverterState}
            onClick={() => onRelayToggle('inverter', !!status?.inverterState)}
            label="Inverter Relay"
            sub={status?.inverterState ? 'Output ON' : 'Output OFF'}
            tone="inverter"
            disabled={!manual || loading}
          />
          <Switch
            on={!!status?.smpsState}
            onClick={() => onRelayToggle('smps', !!status?.smpsState)}
            label="SMPS Charger Relay"
            sub={status?.smpsState ? 'Charging' : 'Standby'}
            tone="brand"
            disabled={!manual || loading}
          />
        </div>
        {!manual && (
          <p className="note">
            <Info size={14} /> Relay switches unlock when the system is in <strong>MANUAL</strong> mode.
          </p>
        )}
      </section>
    </div>
  );
}
