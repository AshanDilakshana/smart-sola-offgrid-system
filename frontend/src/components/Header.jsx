import React, { useLayoutEffect, useRef, useState } from 'react';
import { Zap, Wifi, WifiOff, Server, Database, Cpu, Download, Globe, Home, FlaskConical } from 'lucide-react';

export default function Header({
  status,
  tabs,
  activeTab,
  onTabChange,
  connectionMode,
  onToggleConnection,
  esp32Ip,
  onIpChange,
  showInstall,
  onInstall,
  demoMode,
  onToggleDemo,
}) {
  const navRef = useRef(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0, ready: false });

  useLayoutEffect(() => {
    let mounted = true;
    const update = () => {
      if (!mounted) return;
      const nav = navRef.current;
      if (!nav) return;
      const btn = nav.querySelector(`[data-tab="${activeTab}"]`);
      if (!btn) return;
      setIndicator({ left: btn.offsetLeft, width: btn.offsetWidth, ready: true });
    };
    update();

    let ro;
    if (typeof ResizeObserver !== 'undefined' && navRef.current) {
      ro = new ResizeObserver(update);
      ro.observe(navRef.current);
    }
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(update).catch(() => {});
    }
    window.addEventListener('resize', update);
    return () => {
      mounted = false;
      if (ro) ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [activeTab]);

  const linkLabel = demoMode ? 'DEMO' : status?.localFallbackActive ? 'LAN FALLBACK' : status?.isConnected ? 'LIVE' : status ? 'OFFLINE' : 'CONNECTING';
  const linkTone = demoMode ? 'violet' : status?.localFallbackActive ? 'warning' : status?.isConnected ? 'success' : status ? 'danger' : 'muted';

  return (
    <header className="app-header">
      <div className="header-row">
        <div className="brand">
          <div className="brand-mark">
            <Zap size={20} strokeWidth={2.5} />
          </div>
          <div className="brand-text">
            <div className="brand-line">
              <h1>Smart Solar <span>Off-Grid OS</span></h1>
              <span className={`live-pill tone-${linkTone}`}>
                <span className="live-dot" />
                {linkLabel}
              </span>
            </div>
            <p>ESP32 Dual-Core · JK BMS · AWS IoT MQTT · MongoDB Atlas</p>
          </div>
        </div>

        <div className="header-actions">
          <span className={`chip ${status?.isConnected && status?.mqttConnected !== false ? 'chip--brand' : 'chip--warning'}`} title="MQTT broker link">
            <Server size={12} /> {status?.localFallbackActive ? 'Direct LAN' : 'MQTT'}
          </span>
          <span className={`chip ${status?.mongoConnected ? 'chip--success' : 'chip--muted'}`} title="MongoDB Atlas">
            <Database size={12} /> MongoDB
          </span>
          <span className={`chip ${status?.wifiConnected ? 'chip--success' : 'chip--danger'}`} title={status?.wifiConnected ? `Wi-Fi ${status?.rssi ?? ''} dBm` : 'Wi-Fi disconnected'}>
            {status?.wifiConnected ? <Wifi size={12} /> : <WifiOff size={12} />}
            {status?.rssi ? `${status.rssi}` : 'Wi-Fi'}
          </span>
          <span className="chip chip--violet" title="ESP32 firmware">
            <Cpu size={12} /> {status?.firmwareVersion || 'v1.0.5'}
          </span>

          <div className="conn-switch" role="group" aria-label="Connection mode">
            <button className={connectionMode === 'cloud' ? 'is-on' : ''} onClick={() => connectionMode !== 'cloud' && onToggleConnection()}>
              <Globe size={12} /> Cloud
            </button>
            <button className={connectionMode === 'local' ? 'is-on' : ''} onClick={() => connectionMode !== 'local' && onToggleConnection()}>
              <Home size={12} /> Local
            </button>
          </div>

          {connectionMode === 'local' && (
            <input
              type="text"
              className="input input--ip mono"
              value={esp32Ip}
              onChange={(e) => onIpChange(e.target.value)}
              placeholder="192.168.1.150"
              aria-label="ESP32 IP address"
            />
          )}

          {onToggleDemo && (
            <button
              type="button"
              className={`btn btn--sm ${demoMode ? 'btn--violet' : 'btn--ghost'}`}
              onClick={onToggleDemo}
              title="Toggle live UI simulation preview"
              aria-pressed={demoMode}
            >
              <FlaskConical size={13} /> {demoMode ? 'Demo ON' : 'Demo'}
            </button>
          )}

          {showInstall && (
            <button className="btn btn--primary btn--sm" onClick={onInstall} title="Install Smart Solar as an app">
              <Download size={13} /> Install
            </button>
          )}
        </div>
      </div>

      <nav className="nav-tabs" ref={navRef} aria-label="Sections">
        <span
          className="nav-indicator"
          style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width, opacity: indicator.ready ? 1 : 0 }}
        />
        {tabs.map(tab => (
          <button
            key={tab.id}
            data-tab={tab.id}
            className={`nav-tab ${activeTab === tab.id ? 'is-active' : ''}`}
            onClick={() => onTabChange(tab.id)}
            aria-current={activeTab === tab.id ? 'page' : undefined}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </nav>
    </header>
  );
}
