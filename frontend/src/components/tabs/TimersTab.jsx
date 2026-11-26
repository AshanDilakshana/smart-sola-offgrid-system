import React from 'react';
import { Clock, Activity, Timer, History } from 'lucide-react';
import { formatDuration } from '../../utils/battery';

function Row({ label, value, tone }) {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className={`info-value mono ${tone ? `text-${tone}` : ''}`}>
        {tone && tone !== 'muted' && <span className={`dot dot--${tone}`} />}
        {value}
      </span>
    </div>
  );
}

export default function TimersTab({ status, inverterSessions }) {
  const maxDur = Math.max(1, ...inverterSessions.map(s => s.duration));
  return (
    <div className="tab-panel timers-grid">
      <section className="card reveal">
        <header className="card-head">
          <div className="card-title">
            <span className="icon-tile icon-tile--brand"><Clock size={16} /></span>
            <div><h2>Scheduled RTC Charging</h2><p>DS3231 backed schedule</p></div>
          </div>
        </header>
        <Row label="5:30 PM evening top-up" value={status?.topup530Active ? 'Active (< 14.5 V)' : 'Standby'} tone={status?.topup530Active ? 'brand' : 'muted'} />
        <Row label="1:00 AM night top-up" value={status?.topup1amActive ? 'Active (< 14.5 V)' : 'Standby'} tone={status?.topup1amActive ? 'brand' : 'muted'} />
        <Row label="Normal low-volt charge" value={status?.normalChargingActive ? 'Active (≤ 12.5 V)' : 'Idle'} tone={status?.normalChargingActive ? 'success' : 'muted'} />
        <Row label="Offline clock backup" value="DS3231 RTC" tone="success" />
      </section>

      <section className="card reveal" style={{ '--reveal-delay': '60ms' }}>
        <header className="card-head">
          <div className="card-title">
            <span className="icon-tile icon-tile--violet"><Activity size={16} /></span>
            <div><h2>dV/dt Flatline Detection</h2><p>Full-charge slope monitor</p></div>
          </div>
        </header>
        <Row label="Slope check interval" value="5 min (300 s)" />
        <Row label="Activation voltage" value="≥ 13.5 V" />
        <Row label="Hard stop threshold" value="15.5 V" />
        <Row label="Flatline status" value={status?.flatlineDetected ? 'Cutoff' : 'Normal slope'} tone={status?.flatlineDetected ? 'danger' : 'success'} />
      </section>

      <section className="card reveal" style={{ '--reveal-delay': '120ms' }}>
        <header className="card-head">
          <div className="card-title">
            <span className="icon-tile icon-tile--warning"><Timer size={16} /></span>
            <div><h2>Smart Transfer Delays</h2><p>Relay protection timing</p></div>
          </div>
        </header>
        <Row label="Grid return delay" value="120 s" />
        <Row label="Power-cut transfer delay" value="120 s" />
        <Row label="Grid sensor debounce" value="1,000 ms" />
        <Row label="Offline history buffer" value="32 snapshots (8 h)" tone="brand" />
      </section>

      <section className="card reveal" style={{ '--reveal-delay': '180ms' }}>
        <header className="card-head">
          <div className="card-title">
            <span className="icon-tile icon-tile--success"><History size={16} /></span>
            <div><h2>Inverter Sessions</h2><p>Recorded while this dashboard is open</p></div>
          </div>
        </header>
        {inverterSessions.length === 0 ? (
          <div className="empty-state">No completed inverter sessions yet.</div>
        ) : (
          <div className="sessions">
            {inverterSessions.map((s, i) => (
              <div key={`${s.start}-${i}`} className="session">
                <span className="session-time mono">{s.start}</span>
                <span className="session-track"><span className="session-fill" style={{ width: `${(s.duration / maxDur) * 100}%` }} /></span>
                <span className="session-dur mono">{formatDuration(s.duration)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
