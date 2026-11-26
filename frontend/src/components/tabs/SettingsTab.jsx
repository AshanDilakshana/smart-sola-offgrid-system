import React from 'react';
import { Server, Gauge, CloudLightning, CheckCircle2 } from 'lucide-react';

const THRESHOLDS = [
  { label: 'Low battery inverter cutoff', value: '12.0 V', tone: 'danger', pct: 12 },
  { label: 'Inverter recovery / charge start', value: '12.5 V', tone: 'warning', pct: 28 },
  { label: 'dV/dt flatline monitor start', value: '13.5 V', tone: 'brand', pct: 55 },
  { label: '5:30 PM & 1:00 AM top-up trigger', value: '< 14.5 V', tone: 'brand', pct: 75 },
  { label: 'SMPS hard cutoff (OVP safe)', value: '15.5 V', tone: 'success', pct: 96 },
  { label: 'BMS wire fault protection', value: '< 5.0 V', tone: 'danger', pct: 4 },
];

export default function SettingsTab({ status, loading, backendUrlInput, onBackendUrlChange, onSaveBackendUrl, onOta }) {
  return (
    <div className="tab-panel stack">
      <section className="card reveal">
        <header className="card-head">
          <div className="card-title">
            <span className="icon-tile icon-tile--brand"><Server size={16} /></span>
            <div><h2>Hosted Backend Endpoint</h2><p>MQTT bridge + MongoDB API</p></div>
          </div>
        </header>
        <p className="section-desc">
          URL of your hosted Node.js backend (Render, Railway, VPS or <code>http://localhost:5000</code>). If unreachable, the dashboard automatically falls back to the ESP32 LAN IP.
        </p>
        <form
          className="input-row"
          onSubmit={(e) => { e.preventDefault(); onSaveBackendUrl(); }}
        >
          <input
            type="text"
            inputMode="url"
            spellCheck={false}
            className="input mono"
            value={backendUrlInput}
            onChange={(e) => onBackendUrlChange(e.target.value)}
            placeholder="https://your-api.onrender.com"
            aria-label="Backend URL"
          />
          <button type="submit" className="btn btn--primary">
            <CheckCircle2 size={16} /> Save
          </button>
        </form>
      </section>

      <section className="card reveal" style={{ '--reveal-delay': '60ms' }}>
        <header className="card-head">
          <div className="card-title">
            <span className="icon-tile icon-tile--success"><Gauge size={16} /></span>
            <div><h2>Protection & Charging Thresholds</h2><p>Hard-coded in firmware</p></div>
          </div>
        </header>
        <div className="threshold-grid">
          {THRESHOLDS.map(t => (
            <div key={t.label} className={`threshold tone-${t.tone}`}>
              <div className="threshold-top">
                <span>{t.label}</span>
                <strong className="mono">{t.value}</strong>
              </div>
              <div className="threshold-track"><span style={{ width: `${t.pct}%` }} /></div>
            </div>
          ))}
        </div>
      </section>

      <section className="card ota-card reveal" style={{ '--reveal-delay': '120ms' }}>
        <header className="card-head">
          <div className="card-title">
            <span className="icon-tile icon-tile--violet"><CloudLightning size={16} /></span>
            <div><h2>Over-The-Air Firmware Update</h2><p>Flash the latest GitHub Actions build over Wi-Fi</p></div>
          </div>
        </header>
        <div className="ota-row">
          <div>
            <div className="ota-version">
              Device firmware <span className="chip chip--violet mono">{status?.firmwareVersion || 'v1.0.5'}</span>
            </div>
            <div className="ota-target">Target: latest artifact on <code>main</code></div>
          </div>
          <button className="btn btn--violet" onClick={onOta} disabled={loading}>
            <CloudLightning size={16} className={loading ? 'pulse' : ''} />
            {loading ? 'Sending…' : 'Install latest firmware'}
          </button>
        </div>
      </section>
    </div>
  );
}
