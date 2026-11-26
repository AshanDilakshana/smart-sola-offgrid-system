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
  PlugZap,
  BatteryCharging,
  Signal,
  Timer,
  AlertTriangle,
  ToggleLeft,
  ToggleRight,
  Database,
  Server,
  Cpu,
  CheckCircle2,
  ArrowRight,
  Gauge
} from 'lucide-react';
import {
  fetchSystemStatus,
  setSystemMode,
  toggleForceCharging,
  controlManualRelay,
  triggerOtaUpdate,
  fetchHistory,
  fetchCloudEvents,
  getBackendUrl,
  setBackendUrl
} from './services/esp32Api';

export default function App() {
  const [activeTab, setActiveTab] = useState('overview');
  const [esp32Ip, setEsp32Ip] = useState('192.168.1.150');
  const [backendUrlInput, setBackendUrlInput] = useState(getBackendUrl());
  const [connectionMode, setConnectionMode] = useState('cloud');
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [logs, setLogs] = useState([]);
  const [cloudEvents, setCloudEvents] = useState([]);
  const [logFilter, setLogFilter] = useState('all');
  const [dailyHistory, setDailyHistory] = useState([]);

  // Inverter uptime tracking
  const [inverterOnTime, setInverterOnTime] = useState(0);
  const [inverterSessions, setInverterSessions] = useState([]);
  const inverterTimerRef = useRef(null);
  const prevInverterState = useRef(null);
  const inverterStartRef = useRef(null);

  const addLog = (msg, type = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [{ id: Date.now() + Math.random(), time, msg, type, source: 'ui' }, ...prev.slice(0, 79)]);
  };

  useEffect(() => {
    addLog('System initialized — MQTT + MongoDB Cloud Console active.', 'info');
  }, []);

  useEffect(() => {
    let isMounted = true;
    async function updateStatus() {
      const data = await fetchSystemStatus(esp32Ip, connectionMode);
      if (isMounted && data) {
        setStatus(data);
        if (data.ip && data.ip !== '0.0.0.0') {
          setEsp32Ip(data.ip);
        }
        if (data.isConnected && data.batteryVoltage !== undefined) {
          setHistory(prev => {
            const next = [...prev, { time: new Date().toLocaleTimeString(), volt: data.batteryVoltage }];
            return next.slice(-60);
          });
        }

        // Track inverter ON/OFF transitions
        const isOn = !!data.inverterState;
        if (prevInverterState.current !== isOn) {
          if (isOn) {
            inverterStartRef.current = Date.now();
            inverterTimerRef.current = setInterval(() => {
              setInverterOnTime(prev => prev + 1);
            }, 1000);
          } else if (prevInverterState.current === true) {
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

  // Fetch long-term history & MongoDB events
  useEffect(() => {
    let isMounted = true;
    async function loadHistoryAndEvents() {
      const [histData, eventsData] = await Promise.all([
        fetchHistory(connectionMode),
        fetchCloudEvents(connectionMode)
      ]);
      if (!isMounted) return;

      if (eventsData && eventsData.length > 0) {
        setCloudEvents(eventsData);
      }

      if (!histData) return;

      const dailyMap = {};
      histData.forEach(h => {
        const dateObj = new Date(h.epoch * 1000);
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

          if ((h.mode === 'MANUAL' || h.modeString === 'MANUAL') && h.batteryVoltage <= 12.5) {
            dailyMap[dateStr].deepDischargeCount += 1;
          }
        }
      });

      const sortedDays = Object.values(dailyMap).slice(-7);
      setDailyHistory(sortedDays);
    }
    loadHistoryAndEvents();
  }, [connectionMode, activeTab]);

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
    const W = 600, H = 130, padX = 40, padY = 15;
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

    const gridLines = [];
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const y = padY + (i / steps) * chartH;
      const v = maxV - (i / steps) * rangeV;
      gridLines.push({ y, label: v.toFixed(1) });
    }

    return (
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: '100%' }}>
        {gridLines.map((gl, i) => (
          <g key={i}>
            <line x1={padX} y1={gl.y} x2={W - padX} y2={gl.y} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
            <text x={padX - 6} y={gl.y + 3} fill="var(--text-dim)" fontSize="8" textAnchor="end" fontFamily="var(--font-mono)">{gl.label}V</text>
          </g>
        ))}
        <defs>
          <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(56, 189, 248, 0.32)" />
            <stop offset="100%" stopColor="rgba(56, 189, 248, 0.0)" />
          </linearGradient>
        </defs>
        <polygon points={areaPoints} fill="url(#chartGrad)" />
        <polyline
          points={points.join(' ')}
          fill="none"
          stroke="var(--accent-cyan)"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ filter: 'drop-shadow(0 0 6px rgba(56, 189, 248, 0.45))' }}
        />
        {history.length > 0 && (() => {
          const lastPt = points[points.length - 1].split(',');
          return (
            <circle cx={lastPt[0]} cy={lastPt[1]} r="3.8" fill="var(--accent-cyan)" stroke="#fff" strokeWidth="1.5">
              <animate attributeName="r" values="3.5;5.5;3.5" dur="2s" repeatCount="indefinite" />
            </circle>
          );
        })()}
      </svg>
    );
  };

  const handleModeChange = async (modeVal) => {
    const modeNames = { '-1': 'AUTO', '0': 'POWER OFF', '1': 'ECO', '2': 'POWER CUT', '3': 'ECO+PCUT', '4': 'MANUAL' };

    const confirmed = window.confirm(`Are you sure you want to change the system mode to ${modeNames[modeVal] || 'this mode'}?`);
    if (!confirmed) return;

    setLoading(true);
    addLog(`Mode → ${modeNames[modeVal] || modeVal}`, 'action');
    const res = await setSystemMode(esp32Ip, connectionMode, modeVal);
    if (res?.success) {
      setStatus(prev => prev ? { ...prev, webModeOverride: modeVal } : prev);
      addLog(`MQTT Command Delivered: Mode set to ${modeNames[modeVal]}`, 'success');
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
      addLog(`SMPS Charger ${nextState ? 'FORCE ON' : 'STANDBY'}`, nextState ? 'warning' : 'info');
    }
    setLoading(false);
  };

  const handleRelayToggle = async (relayType, currentState) => {
    setLoading(true);
    addLog(`Relay: ${relayType.toUpperCase()} → ${!currentState ? 'ON' : 'OFF'}`, 'action');
    await controlManualRelay(esp32Ip, connectionMode, relayType, !currentState);
    setStatus(prev => {
      if (!prev) return prev;
      return relayType === 'inverter'
        ? { ...prev, inverterState: !currentState }
        : { ...prev, smpsState: !currentState };
    });
    setLoading(false);
  };

  const handleOtaTrigger = async () => {
    setLoading(true);
    const firmwareUrl = "https://raw.githubusercontent.com/AshanDilakshana/smart-sola-offgrid-system/main/smart_offgrid_logic_/build/smart_offgrid_logic_.ino.bin";
    addLog(`Initiating OTA Update via MQTT from GitHub Binary...`, 'warning');
    const res = await triggerOtaUpdate(esp32Ip, connectionMode, firmwareUrl);
    if (res?.success) {
      addLog(`OTA Update command sent! ESP32 downloading & flashing...`, 'success');
    }
    setLoading(false);
  };

  const handleSaveBackendUrl = () => {
    setBackendUrl(backendUrlInput);
    addLog(`Hosted Backend URL updated to: ${backendUrlInput}`, 'success');
  };

  const calculateSoc = (volt) => {
    if (!volt) return 0;
    return Math.min(100, Math.max(0, Math.round(((volt - 11.5) / (14.4 - 11.5)) * 100)));
  };

  const batVolt = status?.batteryVoltage ?? 13.4;
  const batCurrent = status?.batteryCurrent ?? 0;
  const liveWatts = Math.round(batVolt * Math.abs(batCurrent));
  const soc = status?.batterySoc !== undefined && status.batterySoc > 0 ? status.batterySoc : calculateSoc(batVolt);

  // SVG Gauge math
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
    { id: 'timers', label: 'Timers & Logic', icon: <Clock size={16} /> },
    { id: 'settings', label: 'Cloud & OTA', icon: <SlidersHorizontal size={16} /> },
    { id: 'logs', label: 'Event Logs', icon: <FileText size={16} /> },
  ];

  // Combine UI logs + MongoDB Cloud Event logs
  const mergedLogs = [
    ...logs,
    ...cloudEvents.map((ev, idx) => ({
      id: ev._id || `cloud_${ev.epoch}_${idx}`,
      time: ev.createdAt ? new Date(ev.createdAt).toLocaleTimeString() : new Date((ev.epoch || 0) * 1000).toLocaleTimeString(),
      msg: ev.event,
      type: ev.type || 'info',
      source: 'mongodb'
    }))
  ].filter(item => {
    if (logFilter === 'all') return true;
    if (logFilter === 'action') return item.type === 'action' || item.type === 'success';
    if (logFilter === 'alert') return item.type === 'warning' || item.type === 'danger';
    return true;
  });

  return (
    <div className="app-container">
      {/* =================== MODERN HEADER =================== */}
      <header className="app-header">
        <div className="header-top-row">
          <div className="brand-title">
            <div className="brand-icon">
              <Zap size={22} />
            </div>
            <div className="brand-text">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <h1>Smart Solar Off-Grid OS</h1>
                <span className="live-pill">
                  <span className={`pulse-dot ${status?.isConnected ? 'green' : 'red'}`}></span>
                  {status?.localFallbackActive
                    ? 'LAN FALLBACK'
                    : status?.isConnected
                      ? 'MQTT LIVE'
                      : 'OFFLINE'}
                </span>
              </div>
              <p>ESP32 Dual-Core BMS &bull; AWS IoT MQTT &bull; MongoDB Atlas Telemetry</p>
            </div>
          </div>

          <div className="connection-bar">
            {/* Architecture Health Pills */}
            <span
              className={`badge ${status?.mqttConnected !== false && status?.isConnected ? 'badge-info' : 'badge-warning'}`}
              title="MQTT Broker Link Status"
            >
              <Server size={12} />
              {status?.localFallbackActive ? 'Direct LAN' : 'MQTT Broker'}
            </span>

            <span
              className={`badge ${status?.mongoConnected ? 'badge-success' : 'badge-purple'}`}
              title="MongoDB Atlas Cloud Database"
            >
              <Database size={12} />
              MongoDB
            </span>

            {status?.wifiConnected ? (
              <Wifi size={16} className="text-green" title={`Wi-Fi Connected (${status?.rssi || -60} dBm)`} />
            ) : (
              <WifiOff size={16} className="text-red" title="Wi-Fi Disconnected" />
            )}

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
                addLog(`Connection Mode switched to ${nextMode.toUpperCase()}`, 'info');
              }}
            >
              {connectionMode === 'cloud' ? '🌐 Cloud MQTT' : '🏠 Local IP'}
            </button>

            <span className="badge badge-purple" title="ESP32 Firmware Version">
              <Cpu size={11} /> {status?.firmwareVersion || 'v1.0.5'}
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

      {/* Local Fallback Active Info Banner */}
      {status?.localFallbackActive && (
        <div className="glass-card animate-in" style={{ borderColor: 'var(--accent-yellow)', background: 'rgba(234, 179, 8, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', padding: '0.85rem 1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <ShieldAlert size={20} className="text-yellow" />
            <div style={{ fontSize: '0.8rem' }}>
              <strong style={{ color: 'var(--accent-yellow)' }}>Offline LAN Auto-Fallback Active:</strong> Cloud backend or internet is unreachable, seamlessly communicating directly with ESP32 at <code>http://{esp32Ip}</code>.
            </div>
          </div>
          <span className="badge badge-warning">Zero-Downtime Mode</span>
        </div>
      )}

      {/* Connection Error Alert Banner */}
      {status && status.isConnected === false && (
        <div className="glass-card animate-in" style={{ borderColor: 'var(--accent-red)', background: 'rgba(239, 68, 68, 0.12)', color: 'var(--text-main)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', padding: '1rem 1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <AlertTriangle size={24} className="text-red" style={{ flexShrink: 0 }} />
            <div>
              <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--accent-red)' }}>
                Telemetry Link Offline — ESP32 Running Autonomous Hardware Protection
              </div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.1rem' }}>
                {status.error || 'Unable to reach Cloud Backend or Local ESP32. Core 1 (BMS, Timers, Relays & RTC) continues operating autonomously & buffering history in RAM.'}
              </div>
            </div>
          </div>
          <button
            className="badge badge-warning"
            onClick={() => setConnectionMode(connectionMode === 'cloud' ? 'local' : 'cloud')}
          >
            Try {connectionMode === 'cloud' ? 'Local IP Mode' : 'Cloud Mode'}
          </button>
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
                <span className="status-chip-label">Main Grid</span>
                <span className="status-chip-value" style={{ color: status?.gridPresent ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                  {status?.gridPresent ? 'ONLINE' : 'POWER CUT'}
                </span>
              </div>
            </div>

            <div className="status-chip">
              <div className={`status-chip-icon ${status?.inverterState ? 'cyan' : 'purple'}`}>
                <Power size={18} />
              </div>
              <div className="status-chip-text">
                <span className="status-chip-label">Inverter Output</span>
                <span className="status-chip-value" style={{ color: status?.inverterState ? 'var(--accent-cyan)' : 'var(--text-main)' }}>
                  {status?.inverterState ? 'ACTIVE (ON)' : 'STANDBY'}
                </span>
              </div>
            </div>

            <div className="status-chip">
              <div className={`status-chip-icon ${status?.smpsState ? 'cyan' : 'yellow'}`}>
                <BatteryCharging size={18} />
              </div>
              <div className="status-chip-text">
                <span className="status-chip-label">SMPS Charger</span>
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
                <span className="status-chip-label">Wi-Fi Signal</span>
                <span className="status-chip-value">
                  {status?.rssi ? `${status.rssi} dBm` : '—'}
                </span>
              </div>
            </div>
          </div>

          {/* =================== LIVE ENERGY FLOW TOPOLOGY BAR =================== */}
          <div className="glass-card power-flow-card">
            <div className="card-header" style={{ marginBottom: '0.85rem' }}>
              <span className="card-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Zap size={14} color="var(--accent-cyan)" /> Real-Time Power Routing Topology
              </span>
              <span className="badge badge-info">
                Mode: {status?.modeString || 'POWER OFF'}
              </span>
            </div>

            <div className="power-flow-pipeline">
              {/* Node 1: Main Grid */}
              <div className={`flow-node ${status?.gridPresent ? 'node-online' : 'node-offline'}`}>
                <PlugZap size={20} />
                <div>
                  <div className="flow-node-title">Main Grid (AC)</div>
                  <div className="flow-node-sub">{status?.gridPresent ? '230V Online' : 'Grid Down'}</div>
                </div>
              </div>

              {/* Arrow 1: Grid -> SMPS */}
              <div className={`flow-connector ${status?.gridPresent && status?.smpsState ? 'flow-active-cyan' : ''}`}>
                <div className="flow-line"></div>
                <ArrowRight size={16} />
              </div>

              {/* Node 2: SMPS Charger */}
              <div className={`flow-node ${status?.smpsState ? 'node-charging' : ''}`}>
                <BatteryCharging size={20} />
                <div>
                  <div className="flow-node-title">SMPS Charger</div>
                  <div className="flow-node-sub">{status?.smpsState ? 'Charging Active' : 'Standby'}</div>
                </div>
              </div>

              {/* Arrow 2: SMPS -> Battery */}
              <div className={`flow-connector ${status?.smpsState ? 'flow-active-green' : ''}`}>
                <div className="flow-line"></div>
                <ArrowRight size={16} />
              </div>

              {/* Node 3: 4S LiFePO4 Battery + JK BMS */}
              <div className="flow-node node-battery">
                <Battery size={20} />
                <div>
                  <div className="flow-node-title">4S LiFePO4 ({soc}%)</div>
                  <div className="flow-node-sub">{batVolt.toFixed(2)}V &bull; {batCurrent.toFixed(1)}A ({liveWatts}W)</div>
                </div>
              </div>

              {/* Arrow 3: Battery -> Inverter */}
              <div className={`flow-connector ${status?.inverterState ? 'flow-active-purple' : ''}`}>
                <div className="flow-line"></div>
                <ArrowRight size={16} />
              </div>

              {/* Node 4: Inverter Backup Output */}
              <div className={`flow-node ${status?.inverterState ? 'node-inverter-on' : ''}`}>
                <Power size={20} />
                <div>
                  <div className="flow-node-title">Inverter Output</div>
                  <div className="flow-node-sub">{status?.inverterState ? `ON (${formatTime(inverterOnTime)})` : 'Relay OFF'}</div>
                </div>
              </div>
            </div>
          </div>

          {/* =================== BATTERY HERO GAUGE & METRICS =================== */}
          <div className="battery-hero glass-card">
            <div className="battery-info">
              <div className="battery-info-header">
                <Battery size={18} color="var(--accent-cyan)" />
                <span>JK BMS Smart Battery Telemetry</span>
              </div>
              <div className="battery-voltage">
                {batVolt.toFixed(2)}<span className="unit">V</span>
              </div>

              {/* Live Power & Current Mini Chips */}
              <div className="battery-metrics-row">
                <div className="battery-metric-chip">
                  <span className="battery-metric-label">
                    <Zap size={12} color="var(--accent-cyan)" /> Live Power
                  </span>
                  <div className="battery-metric-val">
                    {liveWatts}<span className="unit">W</span>
                  </div>
                  <span className="battery-metric-sub" style={{ color: batCurrent < -0.05 ? 'var(--accent-green)' : batCurrent > 0.05 ? 'var(--accent-orange)' : 'var(--text-muted)' }}>
                    {batCurrent < -0.05 ? '▲ Charging Flow' : batCurrent > 0.05 ? '▼ Load Discharge' : '• Standby Idle'}
                  </span>
                </div>

                <div className="battery-metric-chip">
                  <span className="battery-metric-label">
                    <Timer size={12} color="var(--accent-purple)" /> Inverter Uptime
                  </span>
                  <div className="battery-metric-val">
                    {formatTime(inverterOnTime)}
                  </div>
                  <span className="battery-metric-sub" style={{ color: status?.inverterState ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                    {status?.inverterState ? '⚡ Backup Running' : 'Inverter Standby'}
                  </span>
                </div>
              </div>

              <div className="battery-badges">
                {status?.smpsState && (
                  <span className="badge badge-info">
                    <RefreshCw size={11} className="spin" /> SMPS Active
                  </span>
                )}
                <span className={`badge ${status?.smpsState || batCurrent < -0.05 ? 'badge-info' : soc > 30 ? 'badge-success' : 'badge-danger'}`}>
                  {status?.smpsState || batCurrent < -0.05 ? '⚡ Charging Bank' : soc > 30 ? '✓ Bank Healthy' : '⚠ Bank Low'}
                </span>
                {status?.forceChargingActive && (
                  <span className="badge badge-warning">Force Charge ON</span>
                )}
                {status?.flatlineDetected && (
                  <span className="badge badge-success">dV/dt Full Cutoff</span>
                )}
              </div>
            </div>

            <div className="gauges-container" style={{ display: 'flex', gap: '1.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
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
                  <div className="svg-gauge-sub">SOC: {soc}%</div>
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
                    stroke={batCurrent < -0.05 ? 'url(#greenGrad)' : batCurrent > 0.05 ? 'url(#redGrad)' : 'url(#cyanGrad)'}
                    strokeWidth="14"
                    strokeDasharray={`${circumference * 0.75} ${circumference * 0.25}`}
                    strokeDashoffset={circumference * 0.75 - ((circumference * 0.75) * Math.min(100, (Math.abs(batCurrent) / 30) * 100)) / 100}
                    strokeLinecap="round"
                    transform="rotate(135 100 100)"
                    style={{ transition: 'stroke-dashoffset 1s cubic-bezier(0.4, 0, 0.2, 1)' }}
                  />
                </svg>
                <div className="svg-gauge-text">
                  <div className="svg-gauge-val" style={{ color: batCurrent < -0.05 ? 'var(--accent-green)' : batCurrent > 0.05 ? 'var(--accent-red)' : 'var(--accent-cyan)' }}>
                    {Math.abs(batCurrent).toFixed(1)}<span>A</span>
                  </div>
                  <div className="svg-gauge-sub" style={{ color: batCurrent < -0.05 ? 'var(--accent-green)' : batCurrent > 0.05 ? 'var(--accent-red)' : 'var(--text-muted)' }}>
                    {batCurrent < -0.05 ? 'Charging Amps' : batCurrent > 0.05 ? 'Discharge Amps' : 'Idle Amps'}
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
                <span>4-Cell LiFePO4 Lithium Balance Monitor (JK BMS)</span>
              </div>

              {(() => {
                const cells = status?.cellVoltages && status.cellVoltages.length >= 4 ? status.cellVoltages : [3.60, 3.59, 3.59, 3.60];
                const valid = cells.filter(v => v > 1.0);
                const minV = valid.length ? Math.min(...valid) : 3.59;
                const maxV = valid.length ? Math.max(...valid) : 3.60;
                const avgV = valid.length ? (valid.reduce((a, b) => a + b, 0) / valid.length) : 3.595;
                const delta = (maxV - minV).toFixed(3);
                return (
                  <div className="cell-balance-delta">
                    <span className="badge badge-info" title="Average Cell Voltage">
                      Avg: {avgV.toFixed(3)} V
                    </span>
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

            <div className="cell-bars-grid">
              {[0, 1, 2, 3].map((idx) => {
                const cells = status?.cellVoltages && status.cellVoltages.length > idx && status.cellVoltages[idx] > 1.0
                  ? status.cellVoltages
                  : [3.601, 3.598, 3.595, 3.594];
                const v = cells[idx] || 3.60;
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
                <span className="card-label">Active Operating Mode</span>
                <div className="pulse-dot cyan"></div>
              </div>
              <div className="active-mode-card">
                <div>
                  <div className="active-mode-value">{status?.modeString || 'POWER OFF'}</div>
                  <div className="active-mode-sub">
                    {status?.webModeOverride === -1 ? 'Auto (Hardware Enclosure Switches)' : 'Cloud / Web Override Active'}
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
                <span className="card-label">Instant SMPS Boost</span>
                <Zap size={16} color="var(--accent-yellow)" />
              </div>
              <div className="force-charge-section">
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  Instantly trigger SMPS charger via MQTT (auto cut-off at 15.5V).
                </p>
                <button
                  className={`btn-force-charge ${status?.forceChargingActive ? 'btn-force-charge-on' : 'btn-force-charge-off'}`}
                  onClick={handleForceChargeToggle}
                  disabled={loading}
                >
                  <Zap size={16} />
                  {status?.forceChargingActive ? 'STOP CHARGE' : 'FORCE CHARGE'}
                </button>
              </div>
            </div>

            {/* Grid Status */}
            <div className="glass-card info-card">
              <div className="card-header">
                <span className="card-label">Main Grid Sensing</span>
                <Radio size={16} color={status?.gridPresent ? 'var(--accent-green)' : 'var(--accent-red)'} />
              </div>
              <div className="card-value" style={{ color: status?.gridPresent ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                {status?.gridPresent ? 'ONLINE' : 'POWER CUT'}
              </div>
              <div className="card-subtitle">1,000ms noise debounce &bull; 120s transfer delay</div>
            </div>

            {/* Solar PV */}
            <div className="glass-card info-card">
              <div className="card-header">
                <span className="card-label">Solar PV Array</span>
                <Sun size={16} color={(status?.solarVoltage || 0) >= 10.0 ? 'var(--accent-green)' : 'var(--accent-yellow)'} />
              </div>
              <div className="card-value" style={{ color: (status?.solarVoltage || 0) >= 10.0 ? 'var(--accent-green)' : 'var(--text-main)' }}>
                {(status?.solarVoltage ?? 0).toFixed(1)}<span style={{ fontSize: '0.9rem', color: 'var(--text-muted)', fontWeight: 500 }}> V</span>
              </div>
              <div className="card-subtitle">
                {(status?.solarVoltage || 0) >= 10.0 ? '☀️ Sunlight Active (ECO Ready ≥ 10.0V)' : 'ECO Window: 08:00 AM – 04:30 PM (≥ 10.0V)'}
              </div>
            </div>
          </div>

          {/* ====== CHARTS SECTION ====== */}
          <div className="charts-grid">
            {/* Battery Voltage History Graph */}
            <div className="glass-card chart-card">
              <div className="card-header">
                <span className="card-label">Live Battery Voltage Waveform</span>
                <TrendingDown size={16} color="var(--accent-cyan)" />
              </div>
              <div className="chart-container">
                {history.length < 2 ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                    Streaming live MQTT telemetry...
                  </div>
                ) : renderVoltageChart()}
              </div>
              <div className="chart-footer">
                <span>{history.length} live samples</span>
                <span>2s real-time interval</span>
              </div>
            </div>

            {/* Daily Inverter Uptime Bar Chart (From MongoDB) */}
            <div className="glass-card chart-card">
              <div className="card-header">
                <span className="card-label">7-Day Inverter Uptime (MongoDB)</span>
                <Clock3 size={16} color="var(--accent-cyan)" />
              </div>

              <div className="bar-chart-container">
                {dailyHistory.length === 0 ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', padding: '2rem 0' }}>
                    Loading MongoDB history...
                  </div>
                ) : (
                  <div className="bar-chart">
                    {dailyHistory.map((day, idx) => {
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
                <span>15-Min MongoDB Snapshots</span>
                <span><strong style={{ color: 'var(--accent-red)' }}>!</strong> = Manual Deep Discharge</span>
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
              <Sliders size={18} color="var(--accent-cyan)" /> System Operating Modes
            </h2>
            <p className="section-desc">
              Commands are pushed instantaneously to ESP32 via MQTT. Flipping any physical switch on the ESP32 box automatically restores AUTO hardware control if offline.
            </p>

            <div className="mode-buttons-grid">
              {[
                { val: -1, label: 'AUTO', sub: 'Physical Switches', icon: <RefreshCw size={20} /> },
                { val: 1, label: 'ECO', sub: 'Battery Priority', icon: <Zap size={20} color="var(--accent-cyan)" /> },
                { val: 2, label: 'POWER CUT', sub: 'UPS Backup Mode', icon: <ShieldAlert size={20} color="var(--accent-yellow)" /> },
                { val: 3, label: 'ECO + PCUT', sub: 'Smart Hybrid Mode', icon: <Activity size={20} color="var(--accent-blue)" /> },
                { val: 4, label: 'MANUAL', sub: 'Direct Relay Control', icon: <Power size={20} color="var(--accent-purple)" /> },
                { val: 0, label: 'POWER OFF', sub: 'Inverter Shutdown', icon: <Power size={20} color="var(--accent-red)" /> },
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
              <Zap size={18} color="var(--accent-yellow)" /> Direct Charger & Relay Overrides
            </h2>
            <p className="section-desc">
              Force SMPS charger anytime or toggle individual relays when in MANUAL mode.
            </p>

            <button
              className={`btn-force-charge ${status?.forceChargingActive ? 'btn-force-charge-on' : 'btn-force-charge-off'}`}
              onClick={handleForceChargeToggle}
              disabled={loading}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              <Zap size={18} />
              {status?.forceChargingActive ? 'STOP FORCE CHARGE' : 'ACTIVATE FORCE CHARGE'}
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
                  SMPS Charger Relay ({status?.smpsState ? 'ON' : 'OFF'})
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
              <Clock size={18} color="var(--accent-cyan)" /> Scheduled RTC Charging
            </h2>
            <div className="info-item">
              <span className="label">5:30 PM Evening Top-Up</span>
              <span className="value" style={{ color: status?.topup530Active ? 'var(--accent-cyan)' : 'var(--text-muted)' }}>
                {status?.topup530Active ? '⚡ ACTIVE (< 14.5V)' : 'Standby'}
              </span>
            </div>
            <div className="info-item">
              <span className="label">1:00 AM Night Top-Up</span>
              <span className="value" style={{ color: status?.topup1amActive ? 'var(--accent-cyan)' : 'var(--text-muted)' }}>
                {status?.topup1amActive ? '⚡ ACTIVE (< 14.5V)' : 'Standby'}
              </span>
            </div>
            <div className="info-item">
              <span className="label">Normal Low-Volt Charge</span>
              <span className="value" style={{ color: status?.normalChargingActive ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                {status?.normalChargingActive ? '⚡ ACTIVE (≤ 12.5V)' : 'Idle'}
              </span>
            </div>
            <div className="info-item">
              <span className="label">Offline Clock Backup</span>
              <span className="value text-green">DS3231 RTC Active</span>
            </div>
          </div>

          <div className="glass-card">
            <h2 className="section-title">
              <Activity size={18} color="var(--accent-purple)" /> dV/dt Flatline Detection
            </h2>
            <div className="info-item">
              <span className="label">Slope Check Interval</span>
              <span className="value text-cyan">5 Minutes (300s)</span>
            </div>
            <div className="info-item">
              <span className="label">Activation Voltage</span>
              <span className="value">&ge; 13.5 V</span>
            </div>
            <div className="info-item">
              <span className="label">Hard Stop Threshold</span>
              <span className="value">15.5 V</span>
            </div>
            <div className="info-item">
              <span className="label">Flatline Status</span>
              <span className={`badge ${status?.flatlineDetected ? 'badge-danger' : 'badge-success'}`}>
                {status?.flatlineDetected ? 'FLATLINE CUTOFF' : 'NORMAL SLOPE'}
              </span>
            </div>
          </div>

          <div className="glass-card">
            <h2 className="section-title">
              <Timer size={18} color="var(--accent-yellow)" /> Smart Transfer Delays
            </h2>
            <div className="info-item">
              <span className="label">Grid Return Delay</span>
              <span className="value">120s (2 Min)</span>
            </div>
            <div className="info-item">
              <span className="label">Power Cut Transfer Delay</span>
              <span className="value">120s (2 Min)</span>
            </div>
            <div className="info-item">
              <span className="label">Grid Sensor Debounce</span>
              <span className="value">1,000 ms</span>
            </div>
            <div className="info-item">
              <span className="label">Offline History RAM Buffer</span>
              <span className="value text-cyan">32 Snapshots (8 Hours)</span>
            </div>
          </div>
        </div>
      )}

      {/* =================== TAB: CLOUD, THRESHOLDS & OTA =================== */}
      {activeTab === 'settings' && (
        <div className="animate-in" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Hosted Backend & MongoDB Cloud Config Card */}
          <div className="glass-card">
            <h2 className="section-title">
              <Server size={18} color="var(--accent-cyan)" /> Hosted Backend (MQTT + MongoDB) Endpoint
            </h2>
            <p className="section-desc">
              Configure the URL of your hosted Node.js Backend (e.g. Render, Railway, VPS, or <code>http://localhost:5000</code>). If unreachable, the dashboard automatically falls back to direct local LAN IP.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="text"
                className="ip-input"
                style={{ flex: 1, minWidth: '240px', padding: '0.6rem 0.85rem', fontSize: '0.85rem' }}
                value={backendUrlInput}
                onChange={(e) => setBackendUrlInput(e.target.value)}
                placeholder="http://localhost:5000 or https://your-api.onrender.com"
              />
              <button
                className="btn-force-charge btn-force-charge-off"
                onClick={handleSaveBackendUrl}
              >
                <CheckCircle2 size={16} /> Save Backend URL
              </button>
            </div>
          </div>

          {/* Hardware Voltage Threshold Matrix */}
          <div className="glass-card">
            <h2 className="section-title">
              <Gauge size={18} color="var(--accent-green)" /> Hardware Protection & Charging Thresholds
            </h2>
            <div className="timers-grid">
              <div className="info-item">
                <span className="label">ECO Solar PV Minimum Voltage</span>
                <span className="value text-green">&ge; 10.0 V</span>
              </div>
              <div className="info-item">
                <span className="label">ECO Sunlight Time Window</span>
                <span className="value text-cyan">08:00 AM – 04:30 PM</span>
              </div>
              <div className="info-item">
                <span className="label">ECO Inverter Start (Battery Full)</span>
                <span className="value text-green">&ge; 14.2 V / 90% SOC</span>
              </div>
              <div className="info-item">
                <span className="label">ECO Inverter Stop (Night Reserve)</span>
                <span className="value text-yellow">&le; 13.1 V / 65% SOC</span>
              </div>
              <div className="info-item">
                <span className="label">Low Battery Inverter Cutoff</span>
                <span className="value text-red">12.0 V</span>
              </div>
              <div className="info-item">
                <span className="label">Inverter Recovery / Normal Charge Start</span>
                <span className="value text-yellow">12.5 V</span>
              </div>
              <div className="info-item">
                <span className="label">dV/dt Flatline Monitor Start</span>
                <span className="value text-cyan">13.5 V</span>
              </div>
              <div className="info-item">
                <span className="label">5:30 PM & 1:00 AM Top-Up Trigger</span>
                <span className="value text-cyan">&lt; 14.5 V</span>
              </div>
              <div className="info-item">
                <span className="label">SMPS Charge Hard Cutoff (OVP Safe)</span>
                <span className="value text-green">15.5 V</span>
              </div>
              <div className="info-item">
                <span className="label">BMS Wire Fault Protection</span>
                <span className="value text-red">&lt; 5.0 V</span>
              </div>
            </div>
          </div>

          {/* OTA Firmware Update Card */}
          <div className="glass-card">
            <h2 className="section-title">
              <CloudLightning size={18} color="var(--accent-purple)" /> Over-The-Air (OTA) Firmware Update
            </h2>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
              Push an instant MQTT OTA command to download and flash the latest compiled GitHub Actions firmware binary directly to the ESP32 over Wi-Fi.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
              <div>
                <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-main)' }}>
                  Current Device Version: <span className="text-purple">{status?.firmwareVersion || 'v1.0.5'}</span>
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.2rem' }}>
                  Target: Latest GitHub Actions Artifact (main branch)
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.85rem' }}>
            <h2 className="section-title" style={{ marginBottom: 0 }}>
              <FileText size={18} color="var(--accent-blue)" /> Live & MongoDB Cloud Event Stream
            </h2>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              {['all', 'action', 'alert'].map(f => (
                <button
                  key={f}
                  className={`badge ${logFilter === f ? 'badge-info' : ''}`}
                  style={{ background: logFilter === f ? undefined : 'rgba(255,255,255,0.04)', color: logFilter === f ? undefined : 'var(--text-muted)' }}
                  onClick={() => setLogFilter(f)}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="log-stream-container">
            {mergedLogs.length === 0 ? (
              <div style={{ color: 'var(--text-muted)' }}>No events recorded yet.</div>
            ) : (
              mergedLogs.map(log => (
                <div key={log.id} className="log-entry" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <span className="log-time">[{log.time}]</span>
                    <span className={`badge ${log.type === 'danger' ? 'badge-danger' : log.type === 'warning' ? 'badge-warning' : log.type === 'success' ? 'badge-success' : 'badge-info'}`} style={{ padding: '0.08rem 0.4rem', fontSize: '0.6rem' }}>
                      {log.source === 'mongodb' ? 'DB' : 'UI'}
                    </span>
                    <span className="log-msg">{log.msg}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
