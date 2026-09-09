import { useEffect, useState, useRef, useSyncExternalStore } from 'react';
import { initEngine, isElectron, ipc, useStats, usePaused, getController } from './engine.js';
import * as history from './history.js';
import { configureSounds, play } from './sounds.js';
import QueueView from './views/QueueView.jsx';
import SettingsView from './views/SettingsView.jsx';
import AddView from './views/AddView.jsx';
import DownloadDock from './components/DownloadDock.jsx';

const NAV = [
  { id: 'queue', label: 'Downloads', icon: '⬇' },
  { id: 'add', label: 'Add music', icon: '＋' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

export default function App() {
  const [view, setView] = useState('queue');
  const [config, setConfig] = useState(null);
  const [ready, setReady] = useState(false);
  const [toasts, setToasts] = useState([]);

  const toast = (text, kind) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = isElectron
        ? await ipc.invoke('get-config').catch(() => ({}))
        : { downloadPath: 'C:\\Users\\you\\Music', concurrency: 3, fallbackServices: ['amazon'] };
      if (cancelled) return;
      setConfig(cfg);
      configureSounds({ enabled: !!cfg.sounds, volume: cfg.soundVolume ?? 0.35 });
      history.loadHistory();
      await initEngine({
        config: cfg,
        log: (evt, data) => isElectron && ipc.send('log', { evt, data }),
      });
      if (!cancelled) setReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!ready || !config) return <Splash />;

  return (
    <div className="app">
      <TrayBridge />
      <Sidebar view={view} setView={setView} />
      <main className="main">
        {view === 'queue' && <QueueView onToast={toast} />}
        {view === 'add' && <AddView onToast={toast} />}
        {view === 'settings' && <SettingsView config={config} setConfig={setConfig} onToast={toast} />}
      </main>
      <DownloadDock />
      <div className="toast-host">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.kind === 'err' ? ' err' : ''}`}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}

function Splash() {
  return (
    <div className="empty" style={{ height: '100%' }}>
      <div className="big">◍</div>
      <h3>Starting the download engine…</h3>
    </div>
  );
}

/**
 * Keeps the system tray in step with the queue.
 *
 * The main process cannot see the controller - the queue lives here - so the
 * tray's status line and its Pause item are fed from the same numbers the
 * sidebar renders, and the tray's own Pause comes back the other way. Mounted
 * once, next to the engine, rather than inside a view: a tray that stopped
 * updating because the user was looking at Settings would be worse than no
 * tray at all.
 */
function TrayBridge() {
  const stats = useStats();
  const paused = usePaused();

  useEffect(() => {
    if (!isElectron) return;
    ipc.send('engine-stats', {
      queued: stats.queued, active: stats.active,
      completed: stats.completed, skipped: stats.skipped, paused,
    });
  }, [stats.queued, stats.active, stats.completed, stats.skipped, paused]);

  useEffect(() => {
    if (!isElectron) return undefined;
    const onCommand = (event, command) => {
      const c = getController();
      if (!c) return;
      if (command === 'pause') c.pause();
      if (command === 'resume') c.resume();
    };
    ipc.on('tray-command', onCommand);
    return () => ipc.removeListener('tray-command', onCommand);
  }, []);

  return null;
}

function Sidebar({ view, setView }) {
  const stats = useStats();
  const paused = usePaused();
  const prevDone = useRef({ completed: 0, skipped: 0 });

  // Sound cues are driven from the numbers rather than from engine events, so
  // one place decides when something is worth hearing about.
  useEffect(() => {
    const p = prevDone.current;
    if (stats.completed > p.completed) play('complete');
    if (stats.skipped > p.skipped) play('skipped');
    const wasBusy = p.completed + p.skipped > 0;
    const nowIdle = stats.queued === 0 && stats.active === 0;
    if (wasBusy && nowIdle && stats.total > 0 &&
        stats.completed + stats.skipped > p.completed + p.skipped) {
      play('finished');
    }
    prevDone.current = { completed: stats.completed, skipped: stats.skipped };
  }, [stats.completed, stats.skipped, stats.queued, stats.active, stats.total]);

  const counts = { queue: stats.queued + stats.active };
  useSyncExternalStore(history.subscribe, history.getSnapshot);
  const looked = history.list().length;

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="mark" aria-hidden="true">♫</span>
        <span>Lucida Fetcher</span>
      </div>

      <nav className="nav">
        {NAV.map((n) => (
          <button
            key={n.id}
            className="nav-item"
            aria-current={view === n.id ? 'page' : undefined}
            onClick={() => setView(n.id)}
          >
            <span aria-hidden="true" style={{ width: 14, textAlign: 'center', opacity: .75 }}>{n.icon}</span>
            <span>{n.label}</span>
            {counts[n.id] > 0 && <span className="count">{counts[n.id]}</span>}
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        <div className="stat-grid">
          <div className="stat accent"><div className="n">{stats.active}</div><div className="l">Working</div></div>
          <div className="stat ok"><div className="n">{stats.completed}</div><div className="l">Done</div></div>
          <div className="stat warn"><div className="n">{stats.skipped}</div><div className="l">Missing</div></div>
          <div className="stat"><div className="n">{looked}</div><div className="l">History</div></div>
        </div>
        <TransportControls paused={paused} idle={stats.queued + stats.active === 0} />
      </div>
    </aside>
  );
}

// A disabled Pause is a control that answers a question nobody asked. With
// nothing running - and nothing held back by a pause - say so instead.
function TransportControls({ paused, idle }) {
  const c = getController();
  if (idle && !paused) {
    return <div className="transport-idle">No downloads in progress</div>;
  }
  return (
    <div className="row-actions">
      <button
        className="btn btn-sm"
        style={{ flex: 1 }}
        onClick={() => (paused ? c.resume() : c.pause())}
      >
        {paused ? '▶ Resume' : '❚❚ Pause'}
      </button>
    </div>
  );
}
