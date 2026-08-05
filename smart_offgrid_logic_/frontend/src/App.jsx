import React, { useState, useEffect } from 'react';
import {
  Zap,
  Sun,
  Battery,
  Wifi,
  WifiOff,
  Power,
  Clock,
  Sliders,
  ShieldAlert,
  Activity,
  RefreshCw,
  Radio,
  FileText,
  SlidersHorizontal,
  ChevronRight,
  CloudLightning,
  Gauge,
  PlugZap,
  BatteryCharging,
  Signal,
  Timer,
  AlertTriangle,
  ToggleLeft,
  ToggleRight
} from 'lucide-react';
import {
  fetchSystemStatus,
  setSystemMode,
  toggleForceCharging,
  controlManualRelay
} from './services/esp32Api';

export default function App() {
  const [activeTab, setActiveTab] = useState('overview');
  const [esp32Ip, setEsp32Ip] = useState('192.168.1.150');
  const [connectionMode, setConnectionMode] = useState('cloud');
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [logs, setLogs] = useState([]);

  const addLog = (msg, type = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [{ id: Date.now() + Math.random(), time, msg, type }, ...prev.slice(0, 49)]);
  };

  useEffect(() => {
    addLog('System initialized — Global Cloud Access Mode active.', 'info');
  }, []);

  useEffect(() => {
    let isMounted = true;
    async function updateStatus() {
      const data = await fetchSystemStatus(esp32Ip, connectionMode);
      if (isMounted && data) {
        setStatus(data);
        setHistory(prev => {
          const next = [...prev, { time: new Date().toLocaleTimeString(), volt: data.batteryVoltage }];
          return next.slice(-25);
        });
      }
    }
    updateStatus();
    const interval = setInterval(updateStatus, 2000);
    return () => { isMounted = false; clearInterval(interval); };
  }, [esp32Ip, connectionMode]);

  const handleModeChange = async (modeVal) => {
    setLoading(true);
    const modeNames = { '-1': 'AUTO', '0': 'POWER OFF', '1': 'ECO', '2': 'POWER CUT', '3': 'ECO+PCUT', '4': 'MANUAL' };
    addLog(`Mode → ${modeNames[modeVal] || modeVal}`, 'action');
    const res = await setSystemMode(esp32Ip, connectionMode, modeVal);
    if (res?.success) {
      setStatus(prev => prev ? { ...prev, webModeOverride: modeVal } : prev);
      addLog(`Mode set: ${modeNames[modeVal]}`, 'success');
    }
    setLoading(false);
  };

  const handleForceChargeToggle = async () => {
    setLoading(true);
    const nextState = !(status?.forceChargingActive);
    addLog(`Force Charge → ${nextState ? 'ON' : 'OFF'}`, 'action');
    const res = await toggleForceCharging(esp32Ip, connectionMode, nextState);
    if (res?.success) {
      setStatus(prev => prev ? { ...prev, forceChargingActive: nextState, smpsState: nextState } : prev);
      addLog(`SMPS ${nextState ? 'FORCE ON' : 'OFF'}`, nextState ? 'warning' : 'info');
    }
    setLoading(false);
  };

  const handleRelayToggle = async (relayType, currentState) => {
    setLoading(true);
    addLog(`Relay: ${relayType} → ${!currentState ? 'ON' : 'OFF'}`, 'action');
    await controlManualRelay(esp32Ip, connectionMode, relayType, !currentState);
    setLoading(false);
  };

  const calculateSoc = (volt) => {
    if (!volt) return 0;
    return Math.min(100, Math.max(0, Math.round(((volt - 11.5) / (14.8 - 11.5)) * 100)));
  };

  const batVolt = status ? status.batteryVoltage : 13.4;
  const soc = calculateSoc(batVolt);

  // SVG Gauge
  const radius = 78;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (soc / 100) * (circumference * 0.75);

  const getSocColor = () => {
    if (status?.smpsState) return 'var(--accent-cyan)';
    if (soc > 60) return 'var(--accent-green)';
    if (soc > 30) return 'var(--accent-yellow)';
    return 'var(--accent-red)';
  };

  const tabs = [
    { id: 'overview', label: 'Overview', icon: <Activity size={16} /> },
    { id: 'controls', label: 'Controls', icon: <Sliders size={16} /> },
    { id: 'timers', label: 'Timers', icon: <Clock size={16} /> },
    { id: 'settings', label: 'Thresholds', icon: <SlidersHorizontal size={16} /> },
    { id: 'logs', label: 'Logs', icon: <FileText size={16} /> },
  ];

  return (
    <div className="app-container">
      {/* =================== HEADER =================== */}
      <header className="app-header">
        <div className="header-top-row">
          <div className="brand-title">
            <div className="brand-icon">
              <Zap size={22} />
            </div>
            <div className="brand-text">
              <h1>Smart Solar Off-Grid</h1>
              <p>ESP32 Power Management Console</p>
            </div>
          </div>

          <div className="connection-bar">
            {status?.wifiConnected ?
              <Wifi size={16} className="text-green" /> :
              <WifiOff size={16} className="text-red" />
            }
            {connectionMode === 'local' && (
              <input
                type="text"
                className="ip-input"
                value={esp32Ip}
                onChange={(e) => setEsp32Ip(e.target.value)}
                placeholder="192.168.1.150"
              />
            )}
            <button
              className={`badge ${connectionMode === 'cloud' ? 'badge-info' : connectionMode === 'local' ? 'badge-warning' : 'badge-danger'}`}
              onClick={() => {
                const nextMode = connectionMode === 'cloud' ? 'local' : connectionMode === 'local' ? 'mock' : 'cloud';
                setConnectionMode(nextMode);
                addLog(`Mode: ${nextMode.toUpperCase()}`, 'info');
              }}
            >
              {connectionMode === 'cloud' ? '🌐 Cloud' : connectionMode === 'local' ? '🏠 Local' : '🧪 Mock'}
            </button>
          </div>
        </div>

        <nav className="nav-tabs">
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`nav-tab-btn ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </nav>
      </header>

      {/* =================== TAB: OVERVIEW =================== */}
      {activeTab === 'overview' && (
        <div className="animate-in" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Status Strip */}
          <div className="status-strip">
            <div className="status-chip">
              <div className={`status-chip-icon ${status?.gridPresent ? 'green' : 'red'}`}>
                <PlugZap size={18} />
              </div>
              <div className="status-chip-text">
                <span className="status-chip-label">Grid</span>
                <span className="status-chip-value" style={{ color: status?.gridPresent ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                  {status?.gridPresent ? 'ONLINE' : 'DOWN'}
                </span>
              </div>
            </div>

            <div className="status-chip">
              <div className={`status-chip-icon ${status?.inverterState ? 'cyan' : 'purple'}`}>
                <Power size={18} />
              </div>
              <div className="status-chip-text">
                <span className="status-chip-label">Inverter</span>
                <span className="status-chip-value">
                  {status?.inverterState ? 'ON' : 'OFF'}
                </span>
              </div>
            </div>

            <div className="status-chip">
              <div className={`status-chip-icon ${status?.smpsState ? 'cyan' : 'yellow'}`}>
                <BatteryCharging size={18} />
              </div>
              <div className="status-chip-text">
                <span className="status-chip-label">SMPS</span>
                <span className="status-chip-value" style={{ color: status?.smpsState ? 'var(--accent-cyan)' : 'var(--text-secondary)' }}>
                  {status?.smpsState ? 'CHARGING' : 'STANDBY'}
                </span>
              </div>
            </div>

            <div className="status-chip">
              <div className="status-chip-icon cyan">
                <Signal size={18} />
              </div>
              <div className="status-chip-text">
                <span className="status-chip-label">Wi-Fi</span>
                <span className="status-chip-value">
                  {status?.rssi ? `${status.rssi} dBm` : '—'}
                </span>
              </div>
            </div>
          </div>

          {/* Battery Hero Gauge */}
          <div className="battery-hero glass-card">
            <div className="battery-info">
              <div className="battery-info-header">
                <Battery size={18} color="var(--accent-cyan)" />
                <span>Battery Bank</span>
              </div>
              <div className="battery-voltage">
                {batVolt.toFixed(1)}<span className="unit">V</span>
              </div>
              <p className="battery-soc-text">
                State of Charge: <strong>{soc}%</strong>
              </p>
              <div className="battery-badges">
                {status?.smpsState && (
                  <span className="badge badge-info">
                    <RefreshCw size={11} className="spin" /> Charging
                  </span>
                )}
                <span className={`badge ${status?.smpsState ? 'badge-info' : soc > 30 ? 'badge-success' : 'badge-danger'}`}>
                  {status?.smpsState ? '⚡ SMPS Active' : soc > 30 ? '✓ Healthy' : '⚠ Low'}
                </span>
                {status?.forceChargingActive && (
                  <span className="badge badge-warning">Force Charge</span>
                )}
              </div>
            </div>

            <div className="svg-gauge-wrapper">
              <svg width="200" height="200" viewBox="0 0 200 200">
                <circle
                  cx="100" cy="100" r={radius}
                  fill="none"
                  stroke="rgba(255,255,255,0.04)"
                  strokeWidth="12"
                  strokeDasharray={`${circumference * 0.75} ${circumference * 0.25}`}
                  transform="rotate(135 100 100)"
                />
                <circle
                  cx="100" cy="100" r={radius}
                  fill="none"
                  stroke={status?.smpsState ? 'url(#cyanGrad)' : soc > 60 ? 'url(#greenGrad)' : soc > 30 ? 'url(#yellowGrad)' : 'url(#redGrad)'}
                  strokeWidth="12"
                  strokeDasharray={`${circumference * 0.75} ${circumference * 0.25}`}
                  strokeDashoffset={strokeDashoffset}
                  strokeLinecap="round"
                  transform="rotate(135 100 100)"
                  style={{ transition: 'stroke-dashoffset 1s cubic-bezier(0.4, 0, 0.2, 1)' }}
                />
                <defs>
                  <linearGradient id="cyanGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#38bdf8" />
                    <stop offset="100%" stopColor="#6366f1" />
                  </linearGradient>
                  <linearGradient id="greenGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#22c55e" />
                    <stop offset="100%" stopColor="#10b981" />
                  </linearGradient>
                  <linearGradient id="yellowGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#eab308" />
                    <stop offset="100%" stopColor="#f59e0b" />
                  </linearGradient>
                  <linearGradient id="redGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#ef4444" />
                    <stop offset="100%" stopColor="#f97316" />
                  </linearGradient>
                </defs>
              </svg>
              <div className="svg-gauge-text">
                <div className="svg-gauge-val" style={{ color: getSocColor() }}>
                  {soc}%
                </div>
                <div className="svg-gauge-sub">{batVolt.toFixed(1)}V DC</div>
              </div>
            </div>
          </div>

          {/* Overview Cards */}
          <div className="overview-cards-grid">
            {/* Active Mode */}
            <div className="glass-card info-card">
              <div className="card-header">
                <span className="card-label">Active Mode</span>
                <div className="pulse-dot cyan"></div>
              </div>
              <div className="active-mode-card">
                <div>
                  <div className="active-mode-value">{status?.modeString || 'POWER OFF'}</div>
                  <div className="active-mode-sub">
                    {status?.webModeOverride === -1 ? 'Auto (Hardware)' : 'Web Override'}
                  </div>
                </div>
                <button className="btn-go-controls" onClick={() => setActiveTab('controls')}>
                  Change <ChevronRight size={14} />
                </button>
              </div>
            </div>

            {/* Force Charge Quick */}
            <div className="glass-card info-card">
              <div className="card-header">
                <span className="card-label">Quick Charge</span>
                <Zap size={16} color="var(--accent-yellow)" />
              </div>
              <div className="force-charge-section">
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  Instantly activate SMPS charger.
                </p>
                <button
                  className={`btn-force-charge ${status?.forceChargingActive ? 'btn-force-charge-on' : 'btn-force-charge-off'}`}
                  onClick={handleForceChargeToggle}
                  disabled={loading}
                >
                  <Zap size={16} />
                  {status?.forceChargingActive ? 'STOP' : 'CHARGE'}
                </button>
              </div>
            </div>

            {/* Grid Status */}
            <div className="glass-card info-card">
              <div className="card-header">
                <span className="card-label">Main Grid</span>
                <Radio size={16} color={status?.gridPresent ? 'var(--accent-green)' : 'var(--accent-red)'} />
              </div>
              <div className="card-value" style={{ color: status?.gridPresent ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                {status?.gridPresent ? 'ONLINE' : 'POWER CUT'}
              </div>
              <div className="card-subtitle">Debounce: 1,000ms filter active</div>
            </div>

            {/* Solar PV */}
            <div className="glass-card info-card">
              <div className="card-header">
                <span className="card-label">Solar PV</span>
                <Sun size={16} color="var(--accent-yellow)" />
              </div>
              <div className="card-value">0.0<span style={{ fontSize: '0.9rem', color: 'var(--text-muted)', fontWeight: 500 }}> V</span></div>
              <div className="card-subtitle">PV Sensor disconnected</div>
            </div>
          </div>
        </div>
      )}

      {/* =================== TAB: CONTROLS =================== */}
      {activeTab === 'controls' && (
        <div className="controls-layout animate-in">
          <div className="glass-card">
            <h2 className="section-title">
              <Sliders size={18} color="var(--accent-cyan)" /> System Modes
            </h2>
            <p className="section-desc">
              Select operating profile. Auto mode uses physical switches on the ESP32 enclosure.
            </p>

            <div className="mode-buttons-grid">
              {[
                { val: -1, label: 'AUTO', sub: 'Physical Switches', icon: <RefreshCw size={20} /> },
                { val: 1, label: 'ECO', sub: 'Battery Priority', icon: <Zap size={20} color="var(--accent-cyan)" /> },
                { val: 2, label: 'POWER CUT', sub: 'UPS Backup', icon: <ShieldAlert size={20} color="var(--accent-yellow)" /> },
                { val: 3, label: 'ECO + PCUT', sub: 'Hybrid Mode', icon: <Activity size={20} color="var(--accent-blue)" /> },
                { val: 4, label: 'MANUAL', sub: 'Full Override', icon: <Power size={20} color="var(--accent-purple)" /> },
                { val: 0, label: 'POWER OFF', sub: 'System Shutdown', icon: <Power size={20} color="var(--accent-red)" /> },
              ].map(mode => (
                <button
                  key={mode.val}
                  className={`mode-card-btn ${status?.webModeOverride === mode.val ? 'active' : ''}`}
                  onClick={() => handleModeChange(mode.val)}
                  disabled={loading}
                >
                  {mode.icon}
                  <span>{mode.label}</span>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 400 }}>{mode.sub}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Manual Overrides */}
          <div className="glass-card">
            <h2 className="section-title">
              <Zap size={18} color="var(--accent-yellow)" /> Manual Overrides
            </h2>
            <p className="section-desc">
              Force SMPS charger or toggle relays in MANUAL mode.
            </p>

            <button
              className={`btn-force-charge ${status?.forceChargingActive ? 'btn-force-charge-on' : 'btn-force-charge-off'}`}
              onClick={handleForceChargeToggle}
              disabled={loading}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              <Zap size={18} />
              {status?.forceChargingActive ? 'STOP FORCE CHARGE' : 'FORCE CHARGE ON'}
            </button>

            {status?.webModeOverride === 4 && (
              <div className="manual-relay-btns">
                <button
                  className="relay-toggle-btn"
                  onClick={() => handleRelayToggle('inverter', status?.inverterState)}
                >
                  {status?.inverterState ? <ToggleRight size={18} className="text-green" /> : <ToggleLeft size={18} />}
                  Inverter Relay ({status?.inverterState ? 'ON' : 'OFF'})
                </button>
                <button
                  className="relay-toggle-btn"
                  onClick={() => handleRelayToggle('smps', status?.smpsState)}
                >
                  {status?.smpsState ? <ToggleRight size={18} className="text-cyan" /> : <ToggleLeft size={18} />}
                  SMPS Relay ({status?.smpsState ? 'ON' : 'OFF'})
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =================== TAB: TIMERS =================== */}
      {activeTab === 'timers' && (
        <div className="timers-grid animate-in">
          <div className="glass-card">
            <h2 className="section-title">
              <Clock size={18} color="var(--accent-cyan)" /> Scheduled Charging
            </h2>
            <div className="info-item">
              <span className="label">5:30 PM Top-Up</span>
              <span className="value" style={{ color: status?.topup530Active ? 'var(--accent-cyan)' : 'var(--text-muted)' }}>
                {status?.topup530Active ? '⚡ ACTIVE' : 'Standby'}
              </span>
            </div>
            <div className="info-item">
              <span className="label">1:00 AM Top-Up</span>
              <span className="value" style={{ color: status?.topup1amActive ? 'var(--accent-cyan)' : 'var(--text-muted)' }}>
                {status?.topup1amActive ? '⚡ ACTIVE' : 'Standby'}
              </span>
            </div>
            <div className="info-item">
              <span className="label">Normal Charge</span>
              <span className="value" style={{ color: status?.normalChargingActive ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                {status?.normalChargingActive ? '⚡ ACTIVE' : 'Idle'}
              </span>
            </div>
          </div>

          <div className="glass-card">
            <h2 className="section-title">
              <Activity size={18} color="var(--accent-purple)" /> Flatline Detection
            </h2>
            <div className="info-item">
              <span className="label">Check Interval</span>
              <span className="value text-cyan">10 min</span>
            </div>
            <div className="info-item">
              <span className="label">Start Threshold</span>
              <span className="value">&gt; 14.5V</span>
            </div>
            <div className="info-item">
              <span className="label">Status</span>
              <span className={`badge ${status?.flatlineDetected ? 'badge-danger' : 'badge-success'}`}>
                {status?.flatlineDetected ? 'DETECTED' : 'NORMAL'}
              </span>
            </div>
          </div>

          <div className="glass-card">
            <h2 className="section-title">
              <Timer size={18} color="var(--accent-yellow)" /> Smart Delays
            </h2>
            <div className="info-item">
              <span className="label">Grid Return Delay</span>
              <span className="value">180s</span>
            </div>
            <div className="info-item">
              <span className="label">Power Cut Delay</span>
              <span className="value">180s</span>
            </div>
          </div>
        </div>
      )}

      {/* =================== TAB: THRESHOLDS =================== */}
      {activeTab === 'settings' && (
        <div className="animate-in">
          <div className="glass-card">
            <h2 className="section-title">
              <SlidersHorizontal size={18} color="var(--accent-cyan)" /> Voltage Calibration
            </h2>
            {[
              { label: 'Charge Start', value: '12.5V', desc: 'Begin normal charging' },
              { label: 'Charge Stop', value: '15.5V', desc: 'Stop at inverter OVP limit' },
              { label: 'Top-Up Trigger', value: '14.5V', desc: 'Evening & night top-up threshold' },
              { label: 'Surface Offset', value: '-0.5V', desc: 'Subtracted when SMPS active' },
              { label: 'Flatline Trigger', value: '14.5V', desc: 'dV/dt monitoring starts' },
            ].map((item, i) => (
              <div className="info-item" key={i}>
                <div>
                  <span className="label">{item.label}</span>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: '0.1rem' }}>{item.desc}</div>
                </div>
                <span className="value text-cyan">{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* =================== TAB: LOGS =================== */}
      {activeTab === 'logs' && (
        <div className="glass-card animate-in">
          <h2 className="section-title">
            <FileText size={18} color="var(--accent-blue)" /> Event Stream
          </h2>
          <div className="log-stream-container">
            {logs.length === 0 ? (
              <div style={{ color: 'var(--text-muted)' }}>No events recorded.</div>
            ) : (
              logs.map(log => (
                <div key={log.id} className="log-entry">
                  <span className="log-time">[{log.time}]</span>
                  <span className="log-msg">{log.msg}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
