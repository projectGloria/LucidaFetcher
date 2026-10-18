import { useEffect, useState, useRef, useSyncExternalStore } from 'react';
import { initEngine, isElectron, ipc, useStats, usePaused, getController } from './engine.js';
import * as history from './history.js';
import { configureSounds, play } from './sounds.js';
import QueueView from './views/QueueView.jsx';
import SettingsView from './views/SettingsView.jsx';
import AddView from './views/AddView.jsx';
import DownloadDock from './components/DownloadDock.jsx';
import RenderBoundary from './components/RenderBoundary.jsx';

const NAV = [
  { id: 'queue', label: 'Downloads', icon: '⬇' },
  { id: 'add', label: 'Add music', icon: '＋' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

export default function App() {
  const [view, setView] = useState('queue');
  const [config, setConfig] = useState(null);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState(null);
  const [throttleOff, setThrottleOff] = useState(false);
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
    })().catch((err) => {
      // Without this, anything thrown while the engine is starting left the app
      // on "Starting the download engine…" for ever - no error, no retry, and
      // nothing on screen from the one app that logs everything.
      console.error('[boot] engine failed to start:', err);
      if (!cancelled) setBootError(err);
    });
    return () => { cancelled = true; };
  }, []);

  // The speed limiter switches itself off when a server will not honour a range
  // request, because the alternative is a transfer that restarts for ever. Main
  // has always announced that; nothing in the React UI listened, so the limit
  // silently stopped applying and Settings went on showing the value it was set
  // to - for the rest of the session and every download in it.
  useEffect(() => {
    if (!isElectron) return undefined;
    const onUnsupported = () => {
      setThrottleOff(true);
      toast('Speed limit turned off — this server restarts the transfer when it is paused.', 'err');
    };
    ipc.on('throttle-unsupported', onUnsupported);
    return () => ipc.removeListener('throttle-unsupported', onUnsupported);
  }, []);

  if (bootError) return <BootFailure error={bootError} />;
  if (!ready || !config) return <Splash />;

  const saveQueueView = (preferences) => {
    setConfig(current => ({ ...current, queueView: preferences }));
    if (isElectron) ipc.send('set-config', { queueView: preferences });
  };

  return (
    <div className="app">
      <TrayBridge />
      <Sidebar view={view} setView={setView} />
      <main className="main">
        <RenderBoundary key={view}>
        {view === 'queue' && <QueueView onToast={toast} preferences={config.queueView} onPreferencesChange={saveQueueView} />}
        {view === 'add' && <AddView onToast={toast} />}
        {view === 'settings' && (
          <SettingsView config={config} setConfig={setConfig} onToast={toast} throttleOff={throttleOff} />
        )}
        </RenderBoundary>
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
 * The engine did not start.
 *
 * Says what happened and offers the log, rather than leaving the splash up for
 * ever - a startup failure is the one situation where the user cannot reach
 * Settings to export a diagnostics report.
 */
function BootFailure({ error }) {
  return (
    <div className="empty" style={{ height: '100%' }}>
      <div className="big">⚠</div>
      <h3>The download engine could not start</h3>
      <p style={{ color: 'var(--muted, #9aa1b8)', maxWidth: 460, textAlign: 'center' }}>
        {String((error && error.message) || error)}
      </p>
      <div className="row-actions" style={{ marginTop: 16 }}>
        <button className="btn" onClick={() => window.location.reload()}>Try again</button>
        {isElectron && (
          <button className="btn" onClick={() => ipc.invoke('open-log-folder')}>Open the log folder</button>
        )}
      </div>
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
  const prevDone = useRef(stats);

  // Sound cues are driven from the numbers rather than from engine events, so
  // one place decides when something is worth hearing about.
  useEffect(() => {
    const p = prevDone.current;
    const changed = stats.completed + stats.skipped > p.completed + p.skipped;
    const nowIdle = stats.queued === 0 && stats.active === 0;
    if (changed && nowIdle && stats.total > 0) {
      play('finished');
    } else if (stats.completed > p.completed) play('complete');
    else if (stats.skipped > p.skipped) play('skipped');
    prevDone.current = stats;
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
  const retrying = c.keepTrying && !c.retryStopped && c.stats.skipped > 0;
  if (idle && !paused && !retrying) {
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
      <button className="btn btn-sm btn-danger" onClick={() => c.cancelAll()}>Cancel all</button>
    </div>
  );
}
