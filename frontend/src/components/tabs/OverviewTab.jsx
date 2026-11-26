import React from 'react';
import { ChevronRight, Zap, Radio, Sun, Sliders } from 'lucide-react';
import StatusStrip from '../StatusStrip';
import BatteryHero from '../BatteryHero';
import BatteryCells from '../BatteryCells';
import PowerFlow from '../PowerFlow';
import ChartsSection from '../Charts';

export default function OverviewTab(props) {
  const {
    status, connected, batVolt, rawCurrent, soc, direction, inverterOnTime,
    cellHistory, history, trendHistory, chartRange, onChartRangeChange, trendLoading,
    dailyHistory, loading, onForceCharge, onGoControls,
  } = props;

  return (
    <div className="tab-panel">
      <StatusStrip status={status} connected={connected} />

      <BatteryHero
        status={status}
        connected={connected}
        batVolt={batVolt}
        rawCurrent={rawCurrent}
        soc={soc}
        direction={direction}
        inverterOnTime={inverterOnTime}
      />

      <BatteryCells
        cellVoltages={status?.cellVoltages}
        cellHistory={cellHistory}
        rawCurrent={rawCurrent}
        chargerOn={!!status?.smpsState}
        connected={connected}
      />

      <PowerFlow
        status={status}
        connected={connected}
        soc={soc}
        batVolt={batVolt}
        rawCurrent={rawCurrent}
        direction={direction}
        inverterOnTime={inverterOnTime}
      />

      <div className="quick-grid">
        <section className="card quick reveal" style={{ '--reveal-delay': '200ms' }}>
          <header className="quick-head">
            <span className="quick-label">Operating Mode</span>
            <span className="icon-tile icon-tile--brand icon-tile--sm"><Sliders size={14} /></span>
          </header>
          <div className="quick-value mono text-brand">{status?.modeString || 'POWER OFF'}</div>
          <p className="quick-sub">
            {status?.webModeOverride === -1 || status?.webModeOverride === undefined ? 'Auto · hardware switches' : 'Cloud / web override active'}
          </p>
          <button className="btn btn--ghost btn--sm quick-action" onClick={onGoControls}>
            Change mode <ChevronRight size={14} />
          </button>
        </section>

        <section className="card quick reveal" style={{ '--reveal-delay': '220ms' }}>
          <header className="quick-head">
            <span className="quick-label">Instant SMPS Boost</span>
            <span className="icon-tile icon-tile--warning icon-tile--sm"><Zap size={14} /></span>
          </header>
          <div className={`quick-value mono ${status?.forceChargingActive ? 'text-warning' : ''}`}>
            {status?.forceChargingActive ? 'ACTIVE' : 'READY'}
          </div>
          <p className="quick-sub">Trigger the charger via MQTT · auto cut-off at 15.5 V</p>
          <button
            className={`btn btn--sm quick-action ${status?.forceChargingActive ? 'btn--danger is-live' : 'btn--success'}`}
            onClick={onForceCharge}
            disabled={loading}
          >
            <Zap size={14} /> {status?.forceChargingActive ? 'Stop charge' : 'Force charge'}
          </button>
        </section>

        <section className="card quick reveal" style={{ '--reveal-delay': '240ms' }}>
          <header className="quick-head">
            <span className="quick-label">Grid Sensing</span>
            <span className={`icon-tile icon-tile--sm ${status?.gridPresent ? 'icon-tile--success' : 'icon-tile--danger'}`}><Radio size={14} /></span>
          </header>
          <div className={`quick-value mono ${!connected ? '' : status?.gridPresent ? 'text-success' : 'text-danger'}`}>
            {!connected ? '—' : status?.gridPresent ? 'ONLINE' : 'POWER CUT'}
          </div>
          <p className="quick-sub">1,000 ms noise debounce · 120 s transfer delay</p>
        </section>

        <section className="card quick reveal" style={{ '--reveal-delay': '260ms' }}>
          <header className="quick-head">
            <span className="quick-label">Solar PV Array</span>
            <span className="icon-tile icon-tile--warning icon-tile--sm"><Sun size={14} className="spin-slow" /></span>
          </header>
          <div className="quick-value mono">
            {(status?.solarVoltage ?? 0).toFixed(1)}<small> V</small>
          </div>
          <p className="quick-sub">Battery backup mode (PV sensor bypassed)</p>
        </section>
      </div>

      <ChartsSection
        history={history}
        trendHistory={trendHistory}
        chartRange={chartRange}
        onChartRangeChange={onChartRangeChange}
        trendLoading={trendLoading}
        dailyHistory={dailyHistory}
      />
    </div>
  );
}
