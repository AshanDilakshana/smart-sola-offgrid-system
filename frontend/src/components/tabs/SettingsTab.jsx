import React from 'react';
import { Server, Gauge, CloudLightning, CheckCircle2, RefreshCw, Sparkles } from 'lucide-react';

const THRESHOLDS = [
  { label: 'Low battery inverter cutoff', value: '12.0 V', tone: 'danger', pct: 12 },
  { label: 'Inverter recovery / charge start', value: '12.5 V', tone: 'warning', pct: 28 },
  { label: 'dV/dt flatline monitor start', value: '13.5 V', tone: 'brand', pct: 55 },
  { label: '5:30 PM & 1:00 AM top-up trigger', value: '< 14.5 V', tone: 'brand', pct: 75 },
  { label: 'SMPS hard cutoff (OVP safe)', value: '15.5 V', tone: 'success', pct: 96 },
  { label: 'BMS wire fault protection', value: '< 5.0 V', tone: 'danger', pct: 4 },
];

export default function SettingsTab({
  status,
  loading,
  backendUrlInput,
  onBackendUrlChange,
  onSaveBackendUrl,
  onOta,
  remoteFirmware,
  hasFirmwareUpdate,
  checkingFirmware,
  onCheckFirmware,
}) {
  const installedVer = status?.firmwareVersion || 'v1.0.5';
  const latestVer = remoteFirmware?.version || installedVer;

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
            <div><h2>Over-The-Air Firmware Update</h2><p>Flash the latest GitHub Actions build over Wi-Fi (No USB needed)</p></div>
          </div>
          {hasFirmwareUpdate ? (
            <span className="chip chip--warning mono">
              <Sparkles size={13} /> Update Available ({latestVer})
            </span>
          ) : (
            <span className="chip chip--success mono">
              <CheckCircle2 size={13} /> Up to date
            </span>
          )}
        </header>
        <div className="ota-row">
          <div>
            <div className="ota-version" style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
              <span>
                Installed on ESP32: <span className="chip chip--violet mono">{installedVer}</span>
              </span>
              <span>
                Latest on <code>main</code>:{' '}
                <span className={`chip ${hasFirmwareUpdate ? 'chip--success' : 'chip--neutral'} mono`}>
                  {latestVer}
                </span>
              </span>
            </div>
            <div className="ota-target">
              {hasFirmwareUpdate
                ? `New firmware ${latestVer} is ready on GitHub main branch. Click Install to flash ESP32 over Wi-Fi.`
                : <>Target: auto-compiled <code>.bin</code> artifact on GitHub <code>main</code> branch</>}
              {remoteFirmware?.builtAt && (
                <span> · Built {new Date(remoteFirmware.builtAt).toLocaleString()}</span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            {onCheckFirmware && (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={onCheckFirmware}
                disabled={checkingFirmware || loading}
              >
                <RefreshCw size={15} className={checkingFirmware ? 'spin' : ''} />
                {checkingFirmware ? 'Checking…' : 'Check GitHub'}
              </button>
            )}
            <button className="btn btn--violet" onClick={onOta} disabled={loading}>
              <CloudLightning size={16} className={loading ? 'pulse' : ''} />
              {loading
                ? 'Sending OTA…'
                : hasFirmwareUpdate
                  ? `Install ${latestVer} Now`
                  : 'Re-install latest firmware'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
