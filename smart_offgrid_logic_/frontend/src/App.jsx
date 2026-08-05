import React, { useState, useEffect } from 'react';
import { 
  Zap, 
  Sun, 
  Battery, 
  Wifi, 
  Power, 
  Clock, 
  Sliders, 
  ShieldAlert, 
  Activity, 
  RefreshCw, 
  CheckCircle2, 
  Radio,
  FileText,
  SlidersHorizontal,
  Info
} from 'lucide-react';
import { 
  fetchSystemStatus, 
  setSystemMode, 
  toggleForceCharging, 
  controlManualRelay 
} from './services/esp32Api';

export default function App() {
  const [activeTab, setActiveTab] = useState('overview'); // overview, controls, timers, settings, logs
  const [esp32Ip, setEsp32Ip] = useState('192.168.1.150');
  const [connectionMode, setConnectionMode] = useState('cloud'); // 'cloud', 'local', 'mock'
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [logs, setLogs] = useState([]);

  // Log append helper
  const addLog = (msg, type = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [{ id: Date.now() + Math.random(), time, msg, type }, ...prev.slice(0, 49)]);
  };

  // Initial log
  useEffect(() => {
    addLog('System web interface initialized in Global Cloud Access Mode.', 'info');
  }, []);

  // Periodic status polling (every 2 seconds)
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
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [esp32Ip, connectionMode]);

  const handleModeChange = async (modeVal) => {
    setLoading(true);
    const modeNames = { '-1': 'AUTO (Switches)', '0': 'POWER OFF', '1': 'ECO MODE', '2': 'POWER CUT', '3': 'ECO+POWER CUT', '4': 'MANUAL' };
    addLog(`Requested Mode Change: ${modeNames[modeVal] || modeVal}`, 'action');
    const res = await setSystemMode(esp32Ip, connectionMode, modeVal);
    if (res && res.success) {
      setStatus(prev => prev ? { ...prev, webModeOverride: modeVal } : prev);
      addLog(`Mode updated successfully to ${modeNames[modeVal]}`, 'success');
    }
    setLoading(false);
  };

  const handleForceChargeToggle = async () => {
    setLoading(true);
    const currentActive = status ? status.forceChargingActive : false;
    const nextState = !currentActive;
    addLog(`Force Charge toggled: ${nextState ? 'ON' : 'OFF'}`, 'action');
    const res = await toggleForceCharging(esp32Ip, connectionMode, nextState);
    if (res && res.success) {
      setStatus(prev => prev ? { ...prev, forceChargingActive: nextState, smpsState: nextState } : prev);
      addLog(`SMPS Charger ${nextState ? 'FORCE ACTIVATED' : 'DEACTIVATED'}`, nextState ? 'warning' : 'info');
    }
    setLoading(false);
  };

  const handleRelayToggle = async (relayType, currentState) => {
    setLoading(true);
    addLog(`Manual Relay Command: ${relayType} -> ${!currentState ? 'ON' : 'OFF'}`, 'action');
    await controlManualRelay(esp32Ip, connectionMode, relayType, !currentState);
    setLoading(false);
  };

  // Calculate SoC (State of Charge %)
  const calculateSoc = (volt) => {
    if (!volt) return 0;
    const soc = Math.min(100, Math.max(0, Math.round(((volt - 11.5) / (14.8 - 11.5)) * 100)));
    return soc;
  };

  const batVolt = status ? status.batteryVoltage : 13.4;
  const soc = calculateSoc(batVolt);

  // SVG Gauge Calculations
  const radius = 80;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (soc / 100) * (circumference * 0.75); // 270 deg arc

  return (
    <div className="app-container">
      {/* Top Application Header */}
      <header className="app-header glass-card">
        <div className="brand-title">
          <div className="brand-icon">
            <Zap size={28} />
          </div>
          <div className="brand-text">
            <h1>Smart Solar Off-Grid Controller</h1>
            <p>Production Web Management Console • ESP32 Smart Systems</p>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="nav-tabs">
          <button 
            className={`nav-tab-btn ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            <Activity size={18} /> Overview
          </button>
          <button 
            className={`nav-tab-btn ${activeTab === 'controls' ? 'active' : ''}`}
            onClick={() => setActiveTab('controls')}
          >
            <Sliders size={18} /> Controls & Modes
          </button>
          <button 
            className={`nav-tab-btn ${activeTab === 'timers' ? 'active' : ''}`}
            onClick={() => setActiveTab('timers')}
          >
            <Clock size={18} /> Timers & Logic
          </button>
          <button 
            className={`nav-tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <SlidersHorizontal size={18} /> Thresholds
          </button>
          <button 
            className={`nav-tab-btn ${activeTab === 'logs' ? 'active' : ''}`}
            onClick={() => setActiveTab('logs')}
          >
            <FileText size={18} /> Event Logs
          </button>
        </nav>

        {/* Connection Bar */}
        <div className="connection-bar">
          <Wifi size={18} className={status?.wifiConnected ? 'text-green' : 'text-muted'} />
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
            className={`badge ${connectionMode === 'cloud' ? 'badge-success' : connectionMode === 'local' ? 'badge-warning' : 'badge-danger'}`}
            onClick={() => {
              const nextMode = connectionMode === 'cloud' ? 'local' : connectionMode === 'local' ? 'mock' : 'cloud';
              setConnectionMode(nextMode);
              addLog(`Switched mode to: ${nextMode.toUpperCase()} Access`, 'info');
            }}
          >
            {connectionMode === 'cloud' ? '🌐 Global Cloud Sync' : connectionMode === 'local' ? '🏠 Local Wi-Fi IP' : '🧪 Live Mock Mode'}
          </button>
        </div>
      </header>

      {/* TAB 1: OVERVIEW & TELEMETRY */}
      {activeTab === 'overview' && (
        <>
          <div className="telemetry-grid">
            {/* Circular Gauge Hero Battery Card */}
            <div className="glass-card hero-battery-card">
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <Battery size={20} color="var(--accent-cyan)" />
                  <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)', fontWeight: '600' }}>
                    Battery Bank Telemetry
                  </span>
                </div>
                <div className="metric-value-large">
                  {batVolt.toFixed(1)} <span className="metric-unit">V</span>
                </div>
                <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', fontSize: '0.9rem' }}>
                  Calculated SoC: <strong style={{ color: '#fff' }}>{soc}%</strong>
                </p>
                <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {status?.smpsState && (
                    <span className="badge badge-success">
                      <RefreshCw size={12} className="spin" /> -0.5V Surface Charge Offset
                    </span>
                  )}
                  <span className={`badge ${status?.smpsState ? 'badge-success' : 'badge-warning'}`}>
                    {status?.smpsState ? '⚡ SMPS CHARGING ACTIVE' : 'DISCHARGING / STANDBY'}
                  </span>
                </div>
              </div>

              {/* Circular SVG Gauge */}
              <div className="svg-gauge-container">
                <svg width="220" height="220" viewBox="0 0 200 200">
                  <circle 
                    cx="100" cy="100" r={radius} 
                    fill="none" 
                    stroke="rgba(255,255,255,0.06)" 
                    strokeWidth="14" 
                    strokeDasharray={`${circumference * 0.75} ${circumference * 0.25}`} 
                    transform="rotate(135 100 100)"
                  />
                  <circle 
                    cx="100" cy="100" r={radius} 
                    fill="none" 
                    stroke={status?.smpsState ? 'url(#cyanGrad)' : soc > 30 ? 'url(#greenGrad)' : 'url(#redGrad)'} 
                    strokeWidth="14" 
                    strokeDasharray={`${circumference * 0.75} ${circumference * 0.25}`} 
                    strokeDashoffset={strokeDashoffset} 
                    strokeLinecap="round" 
                    transform="rotate(135 100 100)"
                    style={{ transition: 'stroke-dashoffset 0.8s ease' }}
                  />
                  <defs>
                    <linearGradient id="cyanGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#00f2fe" />
                      <stop offset="100%" stopColor="#3b82f6" />
                    </linearGradient>
                    <linearGradient id="greenGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#10b981" />
                      <stop offset="100%" stopColor="#34d399" />
                    </linearGradient>
                    <linearGradient id="redGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#ef4444" />
                      <stop offset="100%" stopColor="#f97316" />
                    </linearGradient>
                  </defs>
                </svg>
                <div className="svg-gauge-text">
                  <div className="svg-gauge-val" style={{ color: status?.smpsState ? 'var(--accent-cyan)' : '#fff' }}>
                    {soc}%
                  </div>
                  <div className="svg-gauge-sub">{batVolt.toFixed(1)}V DC</div>
                </div>
              </div>
            </div>

            {/* Grid Power Status Card */}
            <div className="glass-card">
              <div className="card-label">
                <span>Main Grid Line</span>
                <Radio size={18} color={status?.gridPresent ? 'var(--accent-green)' : 'var(--accent-red)'} />
              </div>
              <div className="metric-value-large" style={{ color: status?.gridPresent ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                {status?.gridPresent ? 'GRID ONLINE' : 'POWER CUT'}
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.75rem' }}>
                1,000ms Debounce Filter: Healthy
              </p>
            </div>

            {/* Solar PV Input Card */}
            <div className="glass-card">
              <div className="card-label">
                <span>Solar PV Array</span>
                <Sun size={18} color="var(--accent-yellow)" />
              </div>
              <div className="metric-value-large">
                0.0 <span className="metric-unit">V</span>
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.75rem' }}>
                PV Sensor Disconnected (Night / Off-Grid Mode)
              </p>
            </div>
          </div>

          {/* Quick Actions & Live Telemetry Stream */}
          <div className="controls-section" style={{ marginTop: '1.25rem' }}>
            <div className="glass-card">
              <h2 className="section-title">
                <Sliders size={20} color="var(--accent-cyan)" /> Active System Mode
              </h2>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
                <div>
                  <div style={{ fontSize: '1.75rem', fontWeight: '800', color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>
                    {status?.modeString || 'POWER OFF'}
                  </div>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    Override: {status?.webModeOverride === -1 ? 'AUTO (Hardware Switches)' : 'Software Web Override Active'}
                  </p>
                </div>
                <button 
                  className="nav-tab-btn active"
                  onClick={() => setActiveTab('controls')}
                >
                  Change Mode in Control Center &rarr;
                </button>
              </div>
            </div>

            {/* Force Charge Quick Status */}
            <div className="glass-card force-charge-card">
              <div>
                <h2 className="section-title">
                  <Zap size={20} color="var(--accent-yellow)" /> Force Charge Action
                </h2>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  Instantly activate SMPS charger manually.
                </p>
              </div>
              <button 
                className={`btn-force-charge ${status?.forceChargingActive ? 'btn-force-charge-on' : 'btn-force-charge-off'}`}
                onClick={handleForceChargeToggle}
                disabled={loading}
              >
                <Zap size={20} />
                {status?.forceChargingActive ? 'STOP FORCE CHARGE' : 'FORCE CHARGE ON'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* TAB 2: CONTROL CENTER */}
      {activeTab === 'controls' && (
        <div className="controls-section">
          {/* Mode Selector Card */}
          <div className="glass-card">
            <h2 className="section-title">
              <Sliders size={20} color="var(--accent-cyan)" /> System Automation Modes
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '1.25rem' }}>
              Select system operating profile. Auto mode delegates control to physical switches on the ESP32 enclosure.
            </p>

            <div className="mode-buttons-grid">
              <button 
                className={`mode-card-btn ${status?.webModeOverride === -1 ? 'active' : ''}`}
                onClick={() => handleModeChange(-1)}
                disabled={loading}
              >
                <RefreshCw size={22} />
                <span>AUTO (Physical Switches)</span>
              </button>
              <button 
                className={`mode-card-btn ${status?.webModeOverride === 1 ? 'active' : ''}`}
                onClick={() => handleModeChange(1)}
                disabled={loading}
              >
                <Zap size={22} color="var(--accent-cyan)" />
                <span>ECO MODE</span>
              </button>
              <button 
                className={`mode-card-btn ${status?.webModeOverride === 2 ? 'active' : ''}`}
                onClick={() => handleModeChange(2)}
                disabled={loading}
              >
                <ShieldAlert size={22} color="var(--accent-yellow)" />
                <span>POWER CUT</span>
              </button>
              <button 
                className={`mode-card-btn ${status?.webModeOverride === 3 ? 'active' : ''}`}
                onClick={() => handleModeChange(3)}
                disabled={loading}
              >
                <Activity size={22} color="var(--accent-blue)" />
                <span>ECO + POWER CUT</span>
              </button>
              <button 
                className={`mode-card-btn ${status?.webModeOverride === 4 ? 'active' : ''}`}
                onClick={() => handleModeChange(4)}
                disabled={loading}
              >
                <Power size={22} color="var(--accent-purple)" />
                <span>MANUAL OVERRIDE</span>
              </button>
              <button 
                className={`mode-card-btn ${status?.webModeOverride === 0 ? 'active' : ''}`}
                onClick={() => handleModeChange(0)}
                disabled={loading}
              >
                <Power size={22} color="var(--accent-red)" />
                <span>POWER OFF</span>
              </button>
            </div>
          </div>

          {/* Force Charger & Manual Relay Controls */}
          <div className="glass-card force-charge-card">
            <div>
              <h2 className="section-title">
                <Zap size={22} color="var(--accent-yellow)" /> Manual Overrides
              </h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.25rem' }}>
                Force SMPS Charger ON or manually toggle relays when in MANUAL mode.
              </p>
            </div>

            <button 
              className={`btn-force-charge ${status?.forceChargingActive ? 'btn-force-charge-on' : 'btn-force-charge-off'}`}
              onClick={handleForceChargeToggle}
              disabled={loading}
              style={{ marginBottom: '1rem' }}
            >
              <Zap size={22} />
              {status?.forceChargingActive ? 'STOP FORCE CHARGE' : 'FORCE CHARGE ON'}
            </button>

            {status?.webModeOverride === 4 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <button 
                  className="nav-tab-btn" 
                  style={{ width: '100%', justifyContent: 'center' }}
                  onClick={() => handleRelayToggle('inverter', status?.inverterState)}
                >
                  Toggle Inverter Relay ({status?.inverterState ? 'ON' : 'OFF'})
                </button>
                <button 
                  className="nav-tab-btn" 
                  style={{ width: '100%', justifyContent: 'center' }}
                  onClick={() => handleRelayToggle('smps', status?.smpsState)}
                >
                  Toggle SMPS Relay ({status?.smpsState ? 'ON' : 'OFF'})
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: TIMERS & AUTOMATION */}
      {activeTab === 'timers' && (
        <div className="timers-grid">
          {/* Scheduled Top-Up Charging */}
          <div className="glass-card">
            <h2 className="section-title">
              <Clock size={20} color="var(--accent-cyan)" /> Scheduled Top-Up Charging
            </h2>
            <div className="info-item">
              <span className="label">5:30 PM Evening Top-Up</span>
              <span className="value">
                {status?.topup530Active ? '⚡ ACTIVE NOW' : 'Scheduled at 17:30 (<14.5V)'}
              </span>
            </div>
            <div className="info-item">
              <span className="label">1:00 AM Night Top-Up</span>
              <span className="value">
                {status?.topup1amActive ? '⚡ ACTIVE NOW' : 'Scheduled at 01:00 (<14.5V)'}
              </span>
            </div>
          </div>

          {/* Flatline Detection Monitor */}
          <div className="glass-card">
            <h2 className="section-title">
              <Activity size={20} color="var(--accent-purple)" /> Flatline Detection (dV/dt)
            </h2>
            <div className="info-item">
              <span className="label">Voltage Check Interval</span>
              <span className="value" style={{ color: 'var(--accent-cyan)' }}>10 Minutes</span>
            </div>
            <div className="info-item">
              <span className="label">Detection Start Threshold</span>
              <span className="value">&gt; 14.5 V</span>
            </div>
            <div className="info-item">
              <span className="label">Flatline Status</span>
              <span className={`badge ${status?.flatlineDetected ? 'badge-danger' : 'badge-success'}`}>
                {status?.flatlineDetected ? 'FLATLINE DETECTED (CUT-OFF)' : 'VOLTAGE RISING NORMAL'}
              </span>
            </div>
          </div>

          {/* Smart Delay Timers */}
          <div className="glass-card">
            <h2 className="section-title">
              <Clock size={20} color="var(--accent-yellow)" /> Smart Countdowns
            </h2>
            <div className="info-item">
              <span className="label">Grid Return Delay Timer</span>
              <span className="value">180 Seconds</span>
            </div>
            <div className="info-item">
              <span className="label">Power Cut Delay Timer</span>
              <span className="value">180 Seconds</span>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: THRESHOLDS & CALIBRATION */}
      {activeTab === 'settings' && (
        <div className="timers-grid">
          <div className="glass-card" style={{ gridColumn: 'span 2' }}>
            <h2 className="section-title">
              <SlidersHorizontal size={20} color="var(--accent-cyan)" /> Battery Charging Voltage Calibration
            </h2>
            <div className="info-item">
              <span className="label">BAT_CHARGE_START_THRESHOLD</span>
              <span className="value">12.5 V (Start normal charge)</span>
            </div>
            <div className="info-item">
              <span className="label">BAT_CHARGE_STOP_THRESHOLD</span>
              <span className="value">15.5 V (Stop charge / Inverter OVP)</span>
            </div>
            <div className="info-item">
              <span className="label">BAT_TOPUP_START_THRESHOLD</span>
              <span className="value">14.5 V (5:30 PM & 1:00 AM Top-up)</span>
            </div>
            <div className="info-item">
              <span className="label">CHARGING_OFFSET (Surface Charge)</span>
              <span className="value">-0.5 V (Subtracted when SMPS active)</span>
            </div>
            <div className="info-item">
              <span className="label">DVDT_START_VOLTAGE</span>
              <span className="value">14.5 V (Flatline monitoring trigger)</span>
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: EVENT LOGS */}
      {activeTab === 'logs' && (
        <div className="glass-card">
          <h2 className="section-title">
            <FileText size={20} color="var(--accent-blue)" /> System Event Stream & Logs
          </h2>
          <div className="log-stream-container">
            {logs.length === 0 ? (
              <div style={{ color: 'var(--text-muted)' }}>No logs recorded yet.</div>
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
