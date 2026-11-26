import React, { useMemo, useState } from 'react';
import { ScrollText, Search, X } from 'lucide-react';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'action', label: 'Actions' },
  { id: 'alert', label: 'Alerts' },
];

const TONE = {
  danger: 'danger',
  warning: 'warning',
  success: 'success',
  action: 'violet',
  info: 'brand',
};

export default function LogsTab({ logs = [], filter, onFilterChange }) {
  const [query, setQuery] = useState('');

  const filteredLogs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter((log) => (log.msg || '').toLowerCase().includes(q));
  }, [logs, query]);

  return (
    <div className="tab-panel">
      <section className="card reveal">
        <header className="card-head">
          <div className="card-title">
            <span className="icon-tile icon-tile--brand"><ScrollText size={16} /></span>
            <div>
              <h2>Event Stream</h2>
              <p>Live UI actions + MongoDB cloud events</p>
            </div>
          </div>

          <div className="logs-controls">
            <div className="logs-search">
              <Search size={14} className="logs-search-icon" aria-hidden="true" />
              <input
                type="text"
                className="logs-search-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter events…"
                aria-label="Filter events"
              />
              {query && (
                <button
                  type="button"
                  className="logs-search-clear"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            <div className="segmented" role="tablist" aria-label="Filter events">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.id}
                  className={filter === f.id ? 'is-on' : ''}
                  onClick={() => onFilterChange(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </header>

        <div className="timeline">
          {filteredLogs.length === 0 ? (
            <div className="empty-state">No events match the current filter.</div>
          ) : (
            filteredLogs.map((log, i) => {
              const tone = TONE[log.type] || 'brand';
              return (
                <div
                  key={log.id}
                  className={`tl-item tone-${tone}`}
                  style={{ '--stagger': `${Math.min(i, 12) * 25}ms` }}
                >
                  <span className="tl-dot" />
                  <div className="tl-body">
                    <span className="tl-msg">{log.msg}</span>
                    <span className="tl-meta mono">
                      {log.time}
                      <span className={`tl-src ${log.source === 'mongodb' ? 'is-db' : ''}`}>
                        {log.source === 'mongodb' ? 'DB' : 'UI'}
                      </span>
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
