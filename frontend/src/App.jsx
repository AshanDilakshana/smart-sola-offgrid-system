import React, { useState, useEffect, useRef, useCallback } from 'react';
import { LayoutDashboard, Sliders, Clock, CloudLightning, ScrollText, ShieldAlert, AlertTriangle, Smartphone, X, FlaskConical } from 'lucide-react';
import {
  fetchSystemStatus,
  setSystemMode,
  toggleForceCharging,
  controlManualRelay,
  triggerOtaUpdate,
  fetchHistory,
  fetchDailyUptime,
  fetchCloudEvents,
  saveCloudEvent,
  subscribeCloudEvents,
  getBackendUrl,
  setBackendUrl
} from './services/esp32Api';
import { getFlowDirection, packSocFromVoltage, CELL_COUNT } from './utils/battery';
import Header from './components/Header';
import OverviewTab from './components/tabs/OverviewTab';
import ControlsTab, { MODES } from './components/tabs/ControlsTab';
import TimersTab from './components/tabs/TimersTab';
import SettingsTab from './components/tabs/SettingsTab';
import LogsTab from './components/tabs/LogsTab';
import { ConfirmDialog, ToastStack } from './components/Overlays';

const TABS = [
  { id: 'overview', label: 'Overview', mobileLabel: 'Overview', icon: <LayoutDashboard size={16} /> },
  { id: 'controls', label: 'Controls', mobileLabel: 'Controls', icon: <Sliders size={16} /> },
  { id: 'timers', label: 'Timers & Logic', mobileLabel: 'Timers', icon: <Clock size={16} /> },
  { id: 'settings', label: 'Cloud & OTA', mobileLabel: 'Cloud', icon: <CloudLightning size={16} /> },
  { id: 'logs', label: 'Event Logs', mobileLabel: 'Logs', icon: <ScrollText size={16} /> },
];

const HISTORY_LEN = 60;

const DEMO_SCENARIOS = [
  { id: 'charging', label: 'Charging' },
  { id: 'discharging', label: 'Discharging' },
  { id: 'balancing', label: 'Imbalanced' },
  { id: 'float', label: 'Float' },
];

function buildDemoFrame(scenario, step) {
  let baseCells = [3.362, 3.356, 3.359, 3.351];
  let drift = 0;
  let batteryCurrent = -12.2;
  let smpsState = true;
  let gridPresent = true;
  let inverterState = false;
  let flatlineDetected = false;
  let modeString = 'ECO MODE';
  let webModeOverride = 1;
  let batterySoc = 76;

  if (scenario === 'charging') {
    drift = (step % 45) * 0.00035;
    baseCells = [3.362, 3.356, 3.359, 3.351];
    batteryCurrent = Number((-12.2 + Math.sin(step * 0.5) * 0.35).toFixed(2));
    batterySoc = Math.min(99, 74 + Math.floor((step % 45) / 10));
  } else if (scenario === 'discharging') {
    drift = -((step % 45) * 0.00035);
    baseCells = [3.286, 3.279, 3.284, 3.274];
    batteryCurrent = Number((14.3 + Math.sin(step * 0.5) * 0.75).toFixed(2));
    smpsState = false;
    gridPresent = false;
    inverterState = true;
    modeString = 'POWER CUT';
    webModeOverride = 2;
    batterySoc = Math.max(52, 64 - Math.floor((step % 45) / 10));
  } else if (scenario === 'balancing') {
    drift = (step % 30) * 0.00015;
    baseCells = [3.524, 3.468, 3.492, 3.455];
    batteryCurrent = Number((-4.2 + Math.sin(step * 0.4) * 0.25).toFixed(2));
    batterySoc = 92;
  } else {
    baseCells = [3.421, 3.420, 3.419, 3.421];
    batteryCurrent = 0;
    flatlineDetected = true;
    batterySoc = 100;
  }

  const cellVoltages = baseCells.map((v, i) =>
    Number((v + drift + Math.sin(step * 0.65 + i * 1.1) * 0.0003).toFixed(3))
  );
  const batteryVoltage = Number(cellVoltages.reduce((a, b) => a + b, 0).toFixed(2));

  return {
    isConnected: true,
    wifiConnected: true,
    mqttConnected: true,
    mongoConnected: true,
    rssi: -54,
    firmwareVersion: 'v1.0.5',
    solarVoltage: 0,
    batteryVoltage,
    batteryCurrent,
    batterySoc,
    cellVoltages,
    smpsState,
    gridPresent,
    inverterState,
    flatlineDetected,
    forceChargingActive: false,
    modeString,
    webModeOverride,
    ip: '192.168.1.150',
  };
}

const RANGE_DAYS = { '1d': 1, '7d': 7, '30d': 30, '60d': 60 };

function buildDemoTrend(range) {
  const days = RANGE_DAYS[range] || 1;
  const nowSec = Math.floor(Date.now() / 1000);
  const spanSec = days * 86400;
  const targetPts = days === 1 ? 180 : 320;
  const stepSec = Math.max(120, Math.floor(spanSec / targetPts));
  const pts = [];

  for (let epoch = nowSec - spanSec; epoch <= nowSec; epoch += stepSec) {
    const h = new Date(epoch * 1000).getHours() + new Date(epoch * 1000).getMinutes() / 60;
    let phase = 'idle';
    let batteryCurrent = 0;
    let batteryVoltage = 13.34;
    let batterySoc = 84;

    if (h >= 12.5 && h < 14.5) {
      phase = 'discharging';
      const frac = (h - 12.5) / 2.0;
      batteryCurrent = Number((12.4 + Math.sin(epoch / 300) * 1.4).toFixed(2));
      batterySoc = Math.round(86 - frac * 34);
      batteryVoltage = Number((13.18 - frac * 0.56).toFixed(2));
    } else if (h >= 17.5 && h < 19.0) {
      phase = 'charging';
      const frac = (h - 17.5) / 1.5;
      batteryCurrent = Number((-11.8 - Math.cos(epoch / 400) * 1.1).toFixed(2));
      batterySoc = Math.round(52 + frac * 46);
      batteryVoltage = Number((13.65 + frac * 0.78).toFixed(2));
    } else if (h >= 19.5 && h < 21.5) {
      phase = 'discharging';
      const frac = (h - 19.5) / 2.0;
      batteryCurrent = Number((9.6 + Math.sin(epoch / 360) * 1.6).toFixed(2));
      batterySoc = Math.round(95 - frac * 22);
      batteryVoltage = Number((13.24 - frac * 0.22).toFixed(2));
    } else if (h >= 1.0 && h < 2.0) {
      phase = 'charging';
      const frac = h - 1.0;
      batteryCurrent = -9.4;
      batterySoc = Math.round(74 + frac * 24);
      batteryVoltage = Number((13.85 + frac * 0.52).toFixed(2));
    } else {
      batteryVoltage = Number((13.33 + Math.sin(epoch / 1800) * 0.04).toFixed(2));
    }

    pts.push({ epoch, batteryVoltage, batteryCurrent, batterySoc, phase });
  }
  return pts;
}

function buildDemoDailyUptime() {
  const days = [];
  const now = Date.now();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 86400 * 1000);
    const shortDay = d.toLocaleDateString('en-US', { weekday: 'short' });
    const dateStr = d.toLocaleDateString();
    const hours = [2.2, 4.1, 1.8, 4.6, 2.5, 3.8, 2.9][6 - i];
    days.push({
      dateKey: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      dateStr,
      shortDay,
      uptimeHours: hours,
      deepDischargeCount: i === 3 ? 1 : 0,
      minVoltage: i === 3 ? 12.34 : 12.82,
      maxVoltage: 14.42
    });
  }
  return days;
}

export default function App() {
  const [activeTab, setActiveTab] = useState('overview');
  const [esp32Ip, setEsp32Ip] = useState('192.168.1.150');
  const [backendUrlInput, setBackendUrlInput] = useState(getBackendUrl());
  const [connectionMode, setConnectionMode] = useState('cloud');
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [trendHistory, setTrendHistory] = useState([]);
  const [chartRange, setChartRange] = useState('1d');
  const [trendLoading, setTrendLoading] = useState(false);
  const [cellHistory, setCellHistory] = useState([]);
  const [logs, setLogs] = useState([]);
  const [cloudEvents, setCloudEvents] = useState([]);
  const [logFilter, setLogFilter] = useState('all');
  const [dailyHistory, setDailyHistory] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const [demoMode, setDemoMode] = useState(false);
  const [demoScenario, setDemoScenario] = useState('charging');

  // PWA install state
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isStandalone, setIsStandalone] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  });
  const [isIos] = useState(() => {
    if (typeof window === 'undefined') return false;
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  });
  const [showIosInstallTip, setShowIosInstallTip] = useState(false);

  // Inverter uptime tracking
  const [inverterOnTime, setInverterOnTime] = useState(0);
  const [inverterSessions, setInverterSessions] = useState([]);
  const prevInverterState = useRef(null);
  const inverterStartRef = useRef(null);

  const addLog = useCallback((msg, type = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [{ id: Date.now() + Math.random(), time, msg, type, source: 'ui' }, ...prev.slice(0, 79)]);
  }, []);

  const toast = useCallback((msg, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev.slice(-3), { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3800);
  }, []);

  useEffect(() => {
    addLog('System initialized — MQTT + MongoDB Cloud Console active.', 'info');
  }, [addLog]);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    const handleAppInstalled = () => {
      setIsStandalone(true);
      setDeferredPrompt(null);
      setShowIosInstallTip(false);
      addLog('App installed on device home screen.', 'success');
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, [addLog]);

  const handleInstallApp = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      setDeferredPrompt(null);
    } else if (isIos && !isStandalone) {
      setShowIosInstallTip(prev => !prev);
    }
  };

  // Live telemetry polling (SSE cache / REST / LAN fallback)
  useEffect(() => {
    if (demoMode) return undefined;
    let isMounted = true;
    async function updateStatus() {
      const data = await fetchSystemStatus(esp32Ip, connectionMode);
      if (!isMounted || !data) return;
      setStatus(data);
      if (data.ip && data.ip !== '0.0.0.0' && data.ip !== esp32Ip) {
        setEsp32Ip(data.ip);
      }
      if (data.isConnected && data.batteryVoltage !== undefined) {
        const now = Date.now();
        const phase = getFlowDirection(Number(data.batteryCurrent ?? 0), !!data.smpsState);
        setHistory(prev => [
          ...prev,
          {
            epoch: Math.floor(now / 1000),
            time: new Date(now).toLocaleTimeString(),
            volt: Number(data.batteryVoltage),
            batteryCurrent: Number(data.batteryCurrent ?? 0),
            batterySoc: Number(data.batterySoc ?? 0),
            phase,
          }
        ].slice(-HISTORY_LEN));
        if (Array.isArray(data.cellVoltages) && data.cellVoltages.length >= CELL_COUNT) {
          setCellHistory(prev => [...prev, { t: now, cells: data.cellVoltages.slice(0, CELL_COUNT).map(Number) }].slice(-HISTORY_LEN));
        }
      }
    }
    updateStatus();
    const interval = setInterval(updateStatus, 2000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [esp32Ip, connectionMode, demoMode]);

  // Opt-in live demo simulation mode
  useEffect(() => {
    if (!demoMode) return undefined;

    const now = Date.now();
    const seedCount = 8;
    const seedHist = [];
    const seedCells = [];
    let latestFrame = null;

    for (let k = 0; k < seedCount; k++) {
      const t = now - (seedCount - 1 - k) * 1500;
      const frame = buildDemoFrame(demoScenario, k);
      latestFrame = frame;
      seedHist.push({
        epoch: Math.floor(t / 1000),
        time: new Date(t).toLocaleTimeString(),
        volt: frame.batteryVoltage,
        batteryCurrent: frame.batteryCurrent,
        batterySoc: frame.batterySoc,
        phase: getFlowDirection(frame.batteryCurrent, frame.smpsState),
      });
      seedCells.push({ t, cells: frame.cellVoltages });
    }

    setStatus(latestFrame);
    setHistory(seedHist);
    setCellHistory(seedCells);

    let step = seedCount;
    const timer = setInterval(() => {
      const t = Date.now();
      const frame = buildDemoFrame(demoScenario, step++);
      setStatus(frame);
      setHistory(prev => [
        ...prev,
        {
          epoch: Math.floor(t / 1000),
          time: new Date(t).toLocaleTimeString(),
          volt: frame.batteryVoltage,
          batteryCurrent: frame.batteryCurrent,
          batterySoc: frame.batterySoc,
          phase: getFlowDirection(frame.batteryCurrent, frame.smpsState),
        }
      ].slice(-HISTORY_LEN));
      setCellHistory(prev => [...prev, { t, cells: frame.cellVoltages }].slice(-HISTORY_LEN));
    }, 1500);

    return () => clearInterval(timer);
  }, [demoMode, demoScenario]);

  // Inverter ON/OFF session tracking (independent of the polling effect)
  const inverterOn = !!status?.inverterState;
  useEffect(() => {
    if (prevInverterState.current === inverterOn) return undefined;
    if (inverterOn) {
      inverterStartRef.current = Date.now();
    } else if (prevInverterState.current === true && inverterStartRef.current) {
      const start = inverterStartRef.current;
      const duration = Math.round((Date.now() - start) / 1000);
      if (duration > 0) {
        setInverterSessions(prev => [{ start: new Date(start).toLocaleTimeString(), duration }, ...prev.slice(0, 9)]);
      }
      inverterStartRef.current = null;
    }
    prevInverterState.current = inverterOn;
    return undefined;
  }, [inverterOn]);

  useEffect(() => {
    if (!inverterOn) return undefined;
    const id = setInterval(() => setInverterOnTime(prev => prev + 1), 1000);
    return () => clearInterval(id);
  }, [inverterOn]);

  // Multi-day voltage trend fetching (1D / 7D / 30D / 60D)
  useEffect(() => {
    if (chartRange === 'live') {
      setTrendLoading(false);
      return undefined;
    }

    if (demoMode) {
      setTrendLoading(false);
      setTrendHistory(buildDemoTrend(chartRange));
      return undefined;
    }

    let isMounted = true;
    async function loadTrend() {
      setTrendLoading(true);
      const days = RANGE_DAYS[chartRange] || 1;
      const data = await fetchHistory(connectionMode, days, 480);
      if (!isMounted) return;
      setTrendHistory(Array.isArray(data) ? data : []);
      setTrendLoading(false);
    }
    loadTrend();
    return () => { isMounted = false; };
  }, [chartRange, connectionMode, demoMode]);

  // Daily inverter uptime & MongoDB events
  useEffect(() => {
    if (demoMode) {
      setDailyHistory(buildDemoDailyUptime());
      return undefined;
    }
    let isMounted = true;
    async function loadHistoryAndEvents() {
      const [dailyData, eventsData] = await Promise.all([
        fetchDailyUptime(connectionMode, 7),
        fetchCloudEvents(connectionMode, 150)
      ]);
      if (!isMounted) return;
      if (Array.isArray(eventsData) && eventsData.length > 0) setCloudEvents(eventsData);
      if (Array.isArray(dailyData)) setDailyHistory(dailyData);
    }
    loadHistoryAndEvents();
    return () => { isMounted = false; };
  }, [connectionMode, activeTab, demoMode]);

  // Live SSE cloud events subscription
  useEffect(() => {
    const unsubscribe = subscribeCloudEvents((ev) => {
      setCloudEvents(prev => [ev, ...prev.slice(0, 149)]);
    });
    return unsubscribe;
  }, []);

  // ---------- Actions ----------
  const runModeChange = async (modeVal) => {
    const mode = MODES.find(m => m.val === modeVal);
    const name = mode?.label || modeVal;
    setLoading(true);
    addLog(`Mode → ${name}`, 'action');
    const res = await setSystemMode(esp32Ip, connectionMode, modeVal);
    if (res?.success) {
      setStatus(prev => prev ? { ...prev, webModeOverride: modeVal } : prev);
      addLog(`MQTT command delivered: mode set to ${name}`, 'success');
      toast(`Mode set to ${name}`, 'success');
    } else {
      toast(`Could not change mode to ${name}`, 'danger');
    }
    setLoading(false);
  };

  const handleModeChange = (modeVal) => {
    const mode = MODES.find(m => m.val === modeVal);
    setConfirm({
      title: `Switch to ${mode?.label}?`,
      message: `${mode?.sub}. The command is sent to the ESP32 immediately.`,
      confirmLabel: `Switch to ${mode?.label}`,
      tone: modeVal === 0 ? 'danger' : 'brand',
      onConfirm: () => runModeChange(modeVal),
    });
  };

  const handleForceChargeToggle = async () => {
    setLoading(true);
    const nextState = !(status?.forceChargingActive);
    addLog(`Force Charge → ${nextState ? 'ON' : 'OFF'}`, 'action');
    const res = await toggleForceCharging(esp32Ip, connectionMode, nextState);
    if (res?.success) {
      setStatus(prev => prev ? { ...prev, forceChargingActive: nextState, smpsState: nextState } : prev);
      addLog(`SMPS charger ${nextState ? 'FORCE ON' : 'STANDBY'}`, nextState ? 'warning' : 'info');
      toast(nextState ? 'Force charge activated' : 'Force charge stopped', nextState ? 'warning' : 'success');
    } else {
      toast('Could not toggle force charge', 'danger');
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
    toast(`${relayType === 'inverter' ? 'Inverter' : 'SMPS'} relay ${!currentState ? 'ON' : 'OFF'}`, 'info');
    setLoading(false);
  };

  const runOta = async () => {
    setLoading(true);
    const firmwareUrl = 'https://raw.githubusercontent.com/AshanDilakshana/smart-sola-offgrid-system/main/smart_offgrid_logic_/build/smart_offgrid_logic_.ino.bin';
    addLog('Initiating OTA update via MQTT from GitHub binary…', 'warning');
    const res = await triggerOtaUpdate(esp32Ip, connectionMode, firmwareUrl);
    if (res?.success) {
      addLog('OTA update command sent! ESP32 downloading & flashing…', 'success');
      toast('OTA command sent — ESP32 is flashing', 'success');
    } else {
      toast('Failed to trigger OTA firmware update', 'danger');
    }
    setLoading(false);
  };

  const handleOtaTrigger = () => {
    setConfirm({
      title: 'Install latest firmware?',
      message: 'The ESP32 will download the latest build and reboot. Relays keep their safe state during the update.',
      confirmLabel: 'Start OTA update',
      tone: 'brand',
      onConfirm: runOta,
    });
  };

  const handleSaveBackendUrl = () => {
    setBackendUrl(backendUrlInput);
    addLog(`Hosted backend URL updated to: ${backendUrlInput}`, 'success');
    saveCloudEvent(connectionMode, `Dashboard backend endpoint updated to ${backendUrlInput}`, 'info');
    toast('Backend URL saved', 'success');
  };

  const toggleConnection = () => {
    const nextMode = connectionMode === 'cloud' ? 'local' : 'cloud';
    setConnectionMode(nextMode);
    addLog(`Connection mode switched to ${nextMode.toUpperCase()}`, 'info');
  };

  const toggleDemoMode = useCallback(() => {
    setDemoMode((prev) => {
      const next = !prev;
      setHistory([]);
      setCellHistory([]);
      setStatus(null);
      addLog(
        next ? 'Simulation preview mode enabled.' : 'Simulation preview exited — resuming live telemetry.',
        'info'
      );
      toast(next ? 'Simulation preview active' : 'Resuming live telemetry', 'info');
      return next;
    });
  }, [addLog, toast]);

  // ---------- Derived values ----------
  const connected = !!status?.isConnected && status?.batteryVoltage !== undefined;
  const batVolt = Number(status?.batteryVoltage ?? 0);
  const rawCurrent = Number(status?.batteryCurrent ?? 0);
  const soc = status?.batterySoc !== undefined && status.batterySoc > 0 ? Math.round(status.batterySoc) : packSocFromVoltage(batVolt);
  const direction = getFlowDirection(rawCurrent, !!status?.smpsState);

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
    if (logFilter === 'action') return item.type === 'action' || item.type === 'success';
    if (logFilter === 'alert') return item.type === 'warning' || item.type === 'danger';
    return true;
  });

  return (
    <div className="app-shell">
      <div className="bg-aurora" aria-hidden="true" />
      <div className="bg-grid" aria-hidden="true" />
      {!status && <div className="top-progress" aria-hidden="true" />}

      <div className="app-container">
        <Header
          status={status}
          tabs={TABS}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          connectionMode={connectionMode}
          onToggleConnection={toggleConnection}
          esp32Ip={esp32Ip}
          onIpChange={setEsp32Ip}
          showInstall={!isStandalone && (deferredPrompt || isIos)}
          onInstall={handleInstallApp}
          demoMode={demoMode}
          onToggleDemo={toggleDemoMode}
        />

        {demoMode && (
          <div className="demo-bar reveal">
            <div className="demo-bar-label">
              <FlaskConical size={16} />
              <span><strong>Simulation Mode</strong> (Demo Data)</span>
            </div>
            <div className="demo-scenarios" role="group" aria-label="Simulation scenario">
              {DEMO_SCENARIOS.map((sc) => (
                <button
                  key={sc.id}
                  type="button"
                  className={`demo-pill ${demoScenario === sc.id ? 'is-on' : ''}`}
                  onClick={() => setDemoScenario(sc.id)}
                >
                  {sc.label}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn--ghost btn--sm" onClick={toggleDemoMode}>
              Exit Demo
            </button>
          </div>
        )}

        {showIosInstallTip && !isStandalone && (
          <div className="banner tone-brand">
            <Smartphone size={18} />
            <span>
              Tap <strong>Share</strong> in Safari → <strong>Add to Home Screen</strong> to install Smart Solar as an app.
            </span>
            <button className="icon-btn" onClick={() => setShowIosInstallTip(false)} aria-label="Close install tip"><X size={14} /></button>
          </div>
        )}

        {!demoMode && status?.localFallbackActive && (
          <div className="banner tone-warning">
            <ShieldAlert size={18} />
            <span>
              <strong>LAN auto-fallback active.</strong> Cloud backend unreachable — talking directly to the ESP32 at <code>http://{esp32Ip}</code>.
            </span>
            <span className="chip chip--warning">Zero-downtime</span>
          </div>
        )}

        {!demoMode && status && status.isConnected === false && (
          <div className="banner tone-danger">
            <AlertTriangle size={18} />
            <span>
              <strong>Telemetry link offline.</strong>{' '}
              {status.error || 'ESP32 keeps running autonomous protection (BMS, timers, relays & RTC) and buffers history in RAM.'}
            </span>
            <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
              <button className="btn btn--ghost btn--sm" onClick={toggleConnection}>
                Try {connectionMode === 'cloud' ? 'Local IP' : 'Cloud'}
              </button>
              <button type="button" className="btn btn--primary btn--sm" onClick={toggleDemoMode}>
                <FlaskConical size={13} /> Preview Demo
              </button>
            </div>
          </div>
        )}

        <main key={activeTab} className="tab-enter">
          {activeTab === 'overview' && (
            <OverviewTab
              status={status}
              connected={connected}
              batVolt={batVolt}
              rawCurrent={rawCurrent}
              soc={soc}
              direction={direction}
              inverterOnTime={inverterOnTime}
              cellHistory={cellHistory}
              history={history}
              trendHistory={trendHistory}
              chartRange={chartRange}
              onChartRangeChange={setChartRange}
              trendLoading={trendLoading}
              dailyHistory={dailyHistory}
              loading={loading}
              onForceCharge={handleForceChargeToggle}
              onGoControls={() => setActiveTab('controls')}
            />
          )}
          {activeTab === 'controls' && (
            <ControlsTab
              status={status}
              loading={loading}
              onModeChange={handleModeChange}
              onForceCharge={handleForceChargeToggle}
              onRelayToggle={handleRelayToggle}
            />
          )}
          {activeTab === 'timers' && <TimersTab status={status} inverterSessions={inverterSessions} />}
          {activeTab === 'settings' && (
            <SettingsTab
              status={status}
              loading={loading}
              backendUrlInput={backendUrlInput}
              onBackendUrlChange={setBackendUrlInput}
              onSaveBackendUrl={handleSaveBackendUrl}
              onOta={handleOtaTrigger}
            />
          )}
          {activeTab === 'logs' && <LogsTab logs={mergedLogs} filter={logFilter} onFilterChange={setLogFilter} />}
        </main>

        <footer className="app-footer">
          <span>Smart Solar Off-Grid OS</span>
          <span className="mono">{connectionMode === 'cloud' ? getBackendUrl().replace(/^https?:\/\//, '') : `LAN · ${esp32Ip}`}</span>
        </footer>
      </div>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`mobile-nav-btn ${activeTab === tab.id ? 'is-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            aria-current={activeTab === tab.id ? 'page' : undefined}
          >
            {tab.icon}
            <span>{tab.mobileLabel}</span>
          </button>
        ))}
      </nav>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message}
        confirmLabel={confirm?.confirmLabel}
        tone={confirm?.tone}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { const fn = confirm?.onConfirm; setConfirm(null); fn?.(); }}
      />
      <ToastStack toasts={toasts} onDismiss={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />
    </div>
  );
}
