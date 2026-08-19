import React, { useState, useEffect, useRef } from 'react';
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
  TrendingDown,
  Clock3,
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
  controlManualRelay,
  triggerOtaUpdate,
  fetchHistory
} from './services/esp32Api';

export default function App() {
  const [activeTab, setActiveTab] = useState('overview');
  const [esp32Ip, setEsp32Ip] = useState('192.168.1.150');
  const [connectionMode, setConnectionMode] = useState('cloud');
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [logs, setLogs] = useState([]);
  const [dailyHistory, setDailyHistory] = useState([]); // Array of daily aggregated data

  // Inverter uptime tracking
  const [inverterOnTime, setInverterOnTime] = useState(0); // seconds
  const [inverterSessions, setInverterSessions] = useState([]); // [{start, end, duration}]
  const inverterTimerRef = useRef(null);
  const prevInverterState = useRef(null);
  const inverterStartRef = useRef(null);

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
        if (data.ip) {
          setEsp32Ip(data.ip);
        }
        if (data.isConnected && data.batteryVoltage !== undefined) {
          setHistory(prev => {
            const next = [...prev, { time: new Date().toLocaleTimeString(), volt: data.batteryVoltage }];
            return next.slice(-60); // Keep 2 minutes of data (60 samples at 2s intervals)
          });
        }

        // Track inverter ON/OFF transitions
        const isOn = !!data.inverterState;
        if (prevInverterState.current !== isOn) {
          if (isOn) {
            // Inverter just turned ON
            inverterStartRef.current = Date.now();
            inverterTimerRef.current = setInterval(() => {
              setInverterOnTime(prev => prev + 1);
            }, 1000);
          } else if (prevInverterState.current === true) {
            // Inverter just turned OFF
            if (inverterTimerRef.current) clearInterval(inverterTimerRef.current);
            const duration = inverterStartRef.current ? Math.round((Date.now() - inverterStartRef.current) / 1000) : 0;
            if (duration > 0) {
              setInverterSessions(prev => [
                { start: new Date(inverterStartRef.current).toLocaleTimeString(), duration },
                ...prev.slice(0, 9)
              ]);
            }
          }
          prevInverterState.current = isOn;
        }
      }
    }
    updateStatus();
    const interval = setInterval(updateStatus, 2000);
    return () => {
      isMounted = false;
      clearInterval(interval);
      if (inverterTimerRef.current) clearInterval(inverterTimerRef.current);
    };
  }, [esp32Ip, connectionMode]);

  // Fetch long-term history once on mount or when mode changes
  useEffect(() => {
    let isMounted = true;
    async function loadHistory() {
      const histData = await fetchHistory(connectionMode);
      if (!isMounted || !histData) return;
      
      // Aggregate into daily buckets
      const dailyMap = {};
      histData.forEach(h => {
        const dateObj = new Date(h.epoch * 1000);
        // Format YYYY-MM-DD
        const dateStr = dateObj.toLocaleDateString();
        const shortDay = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
        
        if (!dailyMap[dateStr]) {
          dailyMap[dateStr] = {
            dateStr,
            shortDay,
            uptimeChunks: 0,
            deepDischargeCount: 0
          };
        }
        
        if (h.inverterState) {
          dailyMap[dateStr].uptimeChunks += 1;
          
          if (h.mode === 'MANUAL' && h.batteryVoltage <= 12.5) {
            dailyMap[dateStr].deepDischargeCount += 1;
          }
        }
      });
      
      // Convert map to array and take last 7 days
      const sortedDays = Object.values(dailyMap).slice(-7);
      setDailyHistory(sortedDays);
    }
    loadHistory();
  }, [connectionMode]);

  // Format seconds to HH:MM:SS
  const formatTime = (totalSec) => {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  // SVG Sparkline chart renderer
  const renderVoltageChart = () => {
    if (history.length < 2) return null;
    const W = 600, H = 120, padX = 40, padY = 15;
    const voltages = history.map(h => h.volt);
    const minV = Math.min(...voltages) - 0.3;
    const maxV = Math.max(...voltages) + 0.3;
    const rangeV = maxV - minV || 1;
    const chartW = W - padX * 2;
    const chartH = H - padY * 2;

    const points = history.map((h, i) => {
      const x = padX + (i / (history.length - 1)) * chartW;
      const y = padY + chartH - ((h.volt - minV) / rangeV) * chartH;
      return `${x},${y}`;
    });

    const areaPoints = [
      `${padX},${padY + chartH}`,
      ...points,
      `${padX + chartW},${padY + chartH}`
    ].join(' ');

    // Grid lines
    const gridLines = [];
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const y = padY + (i / steps) * chartH;
      const v = maxV - (i / steps) * rangeV;
      gridLines.push({ y, label: v.toFixed(1) });
    }

    return (
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: '100%' }}>
        {/* Grid lines */}
        {gridLines.map((gl, i) => (
          <g key={i}>
            <line x1={padX} y1={gl.y} x2={W - padX} y2={gl.y} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
            <text x={padX - 6} y={gl.y + 3} fill="var(--text-dim)" fontSize="8" textAnchor="end" fontFamily="var(--font-mono)">{gl.label}</text>
          </g>
        ))}
        {/* Area fill */}
        <defs>
          <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(56, 189, 248, 0.25)" />
            <stop offset="100%" stopColor="rgba(56, 189, 248, 0.0)" />
          </linearGradient>
        </defs>
        <polygon points={areaPoints} fill="url(#chartGrad)" />
        {/* Line */}
        <polyline
          points={points.join(' ')}
          fill="none"
          stroke="var(--accent-cyan)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ filter: 'drop-shadow(0 0 4px rgba(56, 189, 248, 0.4))' }}
        />
        {/* Latest point dot */}
        {history.length > 0 && (() => {
          const lastPt = points[points.length - 1].split(',');
          return (
            <circle cx={lastPt[0]} cy={lastPt[1]} r="3.5" fill="var(--accent-cyan)" stroke="#fff" strokeWidth="1.5">
              <animate attributeName="r" values="3.5;5;3.5" dur="2s" repeatCount="indefinite" />
            </circle>
          );
        })()}
      </svg>
    );
  };

  const handleModeChange = async (modeVal) => {
    const modeNames = { '-1': 'AUTO', '0': 'POWER OFF', '1': 'ECO', '2': 'POWER CUT', '3': 'ECO+PCUT', '4': 'MANUAL' };
    
    // Request confirmation from the user
    const confirmed = window.confirm(`Are you sure you want to change the system mode to ${modeNames[modeVal] || 'this mode'}?`);
    if (!confirmed) return;

    setLoading(true);
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

  const handleOtaTrigger = async () => {
    setLoading(true);
    const firmwareUrl = "https://raw.githubusercontent.com/AshanDilakshana/smart-sola-offgrid-system/battery_Bacup_with-out-sola/smart_offgrid_logic_/build/smart_offgrid_logic_.ino.bin";
    addLog(`Initiating OTA Update from Cloud GitHub Binary...`, 'warning');
    const res = await triggerOtaUpdate(esp32Ip, connectionMode, firmwareUrl);
    if (res?.success) {
      addLog(`OTA Update command sent! ESP32 downloading & flashing...`, 'success');
    }
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
              className={`badge ${connectionMode === 'cloud' ? 'badge-info' : 'badge-warning'}`}
              onClick={() => {
                const nextMode = connectionMode === 'cloud' ? 'local' : 'cloud';
                setConnectionMode(nextMode);
                addLog(`Mode: ${nextMode.toUpperCase()}`, 'info');
              }}
            >
              {connectionMode === 'cloud' ? '🌐 Cloud' : '🏠 Local IP'}
            </button>
            <span className="badge badge-purple" title="ESP32 Firmware Version">
              {status?.firmwareVersion || 'v1.0.1'}
            </span>
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

      {/* Connection Error Alert Banner */}
      {status && status.isConnected === false && (
        <div className="glass-card animate-in" style={{ borderColor: 'var(--accent-red)', background: 'rgba(239, 68, 68, 0.12)', color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '1rem 1.25rem' }}>
          <AlertTriangle size={24} className="text-red" style={{ flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--accent-red)' }}>
              Connection Failed — Real-Time Telemetry Disconnected
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.1rem' }}>
              {status.error || 'Unable to communicate with ESP32 device. Please verify IP address or network connection.'}
            </div>
          </div>
        </div>
      )}

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

          {/* Battery Hero Gauge with Combined Voltage & Amps Meter */}
          <div className="battery-hero glass-card">
            <div className="battery-info">
              <div className="battery-info-header">
                <Battery size={18} color="var(--accent-cyan)" />
                <span>Battery Bank & Live Flow</span>
              </div>
              <div className="battery-voltage">
                {batVolt.toFixed(2)}<span className="unit">V</span>
              </div>


              <div className="battery-badges">
                {status?.smpsState && (
                  <span className="badge badge-info">
                    <RefreshCw size={11} className="spin" /> SMPS Active
                  </span>
                )}
                <span className={`badge ${status?.smpsState || (status?.batteryCurrent || 0) < -0.05 ? 'badge-info' : soc > 30 ? 'badge-success' : 'badge-danger'}`}>
                  {status?.smpsState || (status?.batteryCurrent || 0) < -0.05 ? '⚡ Charging Bank' : soc > 30 ? '✓ Bank Healthy' : '⚠ Bank Low'}
                </span>
                {status?.forceChargingActive && (
                  <span className="badge badge-warning">Force Charge</span>
                )}
              </div>
            </div>

            <div className="gauges-container" style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', justifyContent: 'center' }}>
              {/* Voltage & SOC Gauge */}
              <div className="svg-gauge-wrapper">
                <svg width="100%" height="100%" viewBox="0 0 200 200">
                  <circle
                    cx="100" cy="100" r={radius}
                    fill="none"
                    stroke="rgba(255,255,255,0.04)"
                    strokeWidth="14"
                    strokeDasharray={`${circumference * 0.75} ${circumference * 0.25}`}
                    transform="rotate(135 100 100)"
                  />
                  <circle
                    cx="100" cy="100" r={radius}
                    fill="none"
                    stroke={soc > 60 ? 'url(#greenGrad)' : soc > 30 ? 'url(#yellowGrad)' : 'url(#redGrad)'}
                    strokeWidth="14"
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
                    {batVolt.toFixed(1)}<span>V</span>
                  </div>
                  <div className="svg-gauge-sub">SOC: {status?.batterySoc ?? soc}%</div>
                </div>
              </div>

              {/* Amperage Gauge */}
              <div className="svg-gauge-wrapper">
                <svg width="100%" height="100%" viewBox="0 0 200 200">
                  <circle
                    cx="100" cy="100" r={radius}
                    fill="none"
                    stroke="rgba(255,255,255,0.04)"
                    strokeWidth="14"
                    strokeDasharray={`${circumference * 0.75} ${circumference * 0.25}`}
                    transform="rotate(135 100 100)"
                  />
                  <circle
                    cx="100" cy="100" r={radius}
                    fill="none"
                    stroke={(status?.batteryCurrent || 0) < -0.05 ? 'url(#greenGrad)' : (status?.batteryCurrent || 0) > 0.05 ? 'url(#redGrad)' : 'url(#cyanGrad)'}
                    strokeWidth="14"
                    strokeDasharray={`${circumference * 0.75} ${circumference * 0.25}`}
                    strokeDashoffset={circumference * 0.75 - ((circumference * 0.75) * Math.min(100, (Math.abs(status?.batteryCurrent || 0) / 30) * 100)) / 100}
                    strokeLinecap="round"
                    transform="rotate(135 100 100)"
                    style={{ transition: 'stroke-dashoffset 1s cubic-bezier(0.4, 0, 0.2, 1)' }}
                  />
                </svg>
                <div className="svg-gauge-text">
                  <div className="svg-gauge-val" style={{ color: (status?.batteryCurrent || 0) < -0.05 ? 'var(--accent-green)' : (status?.batteryCurrent || 0) > 0.05 ? 'var(--accent-red)' : 'var(--accent-cyan)' }}>
                    {Math.abs(status?.batteryCurrent || 0).toFixed(1)}<span>A</span>
                  </div>
                  <div className="svg-gauge-sub" style={{ color: (status?.batteryCurrent || 0) < -0.05 ? 'var(--accent-green)' : (status?.batteryCurrent || 0) > 0.05 ? 'var(--accent-red)' : 'var(--text-muted)' }}>
                    {(status?.batteryCurrent || 0) < -0.05 ? 'Charging Amps' : (status?.batteryCurrent || 0) > 0.05 ? 'Discharge Amps' : 'Idle Amps'}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* =================== 4-CELL VOLTAGE BALANCE BAR CHART =================== */}
          <div className="cell-balance-card glass-card">
            <div className="cell-balance-header">
              <div className="cell-balance-title">
                <BatteryCharging size={18} color="var(--accent-cyan)" />
                <span>4-Cell Lithium Balance Monitor</span>
              </div>

              {(() => {
                const cells = status?.cellVoltages && status.cellVoltages.length >= 4 ? status.cellVoltages : [3.60, 3.59, 3.59, 3.60];
                const valid = cells.filter(v => v > 1.0);
                const minV = valid.length ? Math.min(...valid) : 3.59;
                const maxV = valid.length ? Math.max(...valid) : 3.60;
                const delta = (maxV - minV).toFixed(3);
                return (
                  <div className="cell-balance-delta">
                    <span className="badge badge-purple" title="Max cell difference">
                      ΔV: {delta} V
                    </span>
                    <span className={`badge ${parseFloat(delta) < 0.03 ? 'badge-success' : parseFloat(delta) < 0.08 ? 'badge-warning' : 'badge-danger'}`}>
                      {parseFloat(delta) < 0.03 ? '✓ Perfect Balance' : parseFloat(delta) < 0.08 ? '⚡ Balancing' : '⚠ Imbalanced'}
                    </span>
                  </div>
                );
              })()}
            </div>

            {/* 4 Cell Bars Grid */}
            <div className="cell-bars-grid">
              {[0, 1, 2, 3].map((idx) => {
                const cells = status?.cellVoltages && status.cellVoltages.length > idx && status.cellVoltages[idx] > 1.0 
                  ? status.cellVoltages 
                  : [3.601, 3.598, 3.595, 3.594];
                const v = cells[idx] || 3.60;
                // Scale from 2.80V to 3.65V (LiFePO4 cell range)
                const pct = Math.min(100, Math.max(5, Math.round(((v - 2.80) / (3.65 - 2.80)) * 100)));
                const barColor = v >= 3.45 ? 'linear-gradient(90deg, #38bdf8, #22c55e)' : v >= 3.20 ? 'linear-gradient(90deg, #22c55e, #10b981)' : v >= 3.00 ? 'linear-gradient(90deg, #eab308, #f59e0b)' : 'linear-gradient(90deg, #ef4444, #f97316)';

                return (
                  <div key={idx} className="cell-item">
                    <div className="cell-top-row">
                      <span className="cell-badge-num">
                        <Battery size={12} color="var(--accent-cyan)" /> Cell {idx + 1}
                      </span>
                      <span className="badge badge-info" style={{ padding: '0.15rem 0.45rem', fontSize: '0.65rem' }}>
                        {pct}%
                      </span>
                    </div>

                    <div className="cell-volt-val">
                      {v.toFixed(3)}<span className="unit">V</span>
                    </div>

                    <div className="cell-bar-track">
                      <div 
                        className="cell-bar-fill" 
                        style={{ 
                          width: `${pct}%`, 
                          background: barColor,
                          boxShadow: `0 0 10px ${v >= 3.3 ? 'rgba(34, 197, 94, 0.35)' : 'rgba(234, 179, 8, 0.35)'}`
                        }} 
                      />
                    </div>

                    <div className="cell-footer-row">
                      <span>2.80V min</span>
                      <span>3.65V max</span>
                    </div>
                  </div>
                );
              })}
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

          {/* ====== CHARTS SECTION ====== */}
          <div className="charts-grid">
            {/* Battery Voltage History Graph */}
            <div className="glass-card chart-card">
              <div className="card-header">
                <span className="card-label">Battery Voltage History</span>
                <TrendingDown size={16} color="var(--accent-cyan)" />
              </div>
              <div className="chart-container">
                {history.length < 2 ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                    Collecting data...
                  </div>
                ) : renderVoltageChart()}
              </div>
              <div className="chart-footer">
                <span>{history.length} samples</span>
                <span>Live 2s interval</span>
              </div>
            </div>

            {/* Daily Inverter Uptime Bar Chart */}
            <div className="glass-card chart-card">
              <div className="card-header">
                <span className="card-label">7-Day Inverter Uptime</span>
                <Clock3 size={16} color="var(--accent-cyan)" />
              </div>

              <div className="bar-chart-container">
                {dailyHistory.length === 0 ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', padding: '2rem 0' }}>
                    Loading history...
                  </div>
                ) : (
                  <div className="bar-chart">
                    {dailyHistory.map((day, idx) => {
                      // 1 chunk = 15 mins. Max expected per day = 24h = 96 chunks
                      const hours = (day.uptimeChunks * 15) / 60;
                      const heightPercent = Math.min(100, (hours / 24) * 100);
                      const hasDeepDischarge = day.deepDischargeCount > 0;
                      
                      return (
                        <div key={idx} className="bar-item">
                          <div className="bar-fill-wrapper">
                            <div 
                              className={`bar-fill ${hasDeepDischarge ? 'danger' : 'normal'}`}
                              style={{ height: `${heightPercent}%` }}
                            >
                              <span className="bar-value">{hours > 0 ? hours.toFixed(1) + 'h' : ''}</span>
                            </div>
                          </div>
                          <div className="bar-label">{day.shortDay}</div>
                          {hasDeepDischarge && (
                            <div className="bar-event-badge" title={`${day.deepDischargeCount} deep discharges in Manual mode`}>!</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="chart-footer">
                <span>Daily Total Hours</span>
                <span><strong style={{color: 'var(--accent-red)'}}>!</strong> = Deep Discharge in Manual Mode</span>
              </div>
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
              <span className="value text-cyan">5 min</span>
            </div>
            <div className="info-item">
              <span className="label">Start Threshold</span>
              <span className="value">&gt; 14.0V</span>
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

          {/* OTA Firmware Update Card */}
          <div className="glass-card" style={{ marginTop: '1rem' }}>
            <h2 className="section-title">
              <CloudLightning size={18} color="var(--accent-purple)" /> Over-The-Air (OTA) Firmware Update
            </h2>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
              Download and flash the latest compiled firmware binary directly to the ESP32 chip over Wi-Fi.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
              <div>
                <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-main)' }}>
                  Current Device Version: <span className="text-purple">{status?.firmwareVersion || 'v1.0.1'}</span>
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.2rem' }}>
                  Target: Latest GitHub Actions Artifact (battery_Bacup_with-out-sola)
                </div>
              </div>
              <button
                className="btn-force-charge"
                style={{ background: 'linear-gradient(135deg, var(--accent-purple), var(--accent-indigo))', color: '#fff' }}
                onClick={handleOtaTrigger}
                disabled={loading}
              >
                <CloudLightning size={18} />
                {loading ? 'SENDING OTA COMMAND...' : 'INSTALL LATEST FIRMWARE (OTA)'}
              </button>
            </div>
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
