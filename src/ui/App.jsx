import { useEffect, useState, useRef } from 'react';
import { initEngine, isElectron, ipc, useStats, usePaused, getController } from './engine.js';
import * as history from './history.js';
import { configureSounds, play } from './sounds.js';
import QueueView from './views/QueueView.jsx';
import SettingsView from './views/SettingsView.jsx';
import AddView from './views/AddView.jsx';
import TransportBar from './components/TransportBar.jsx';
import RenderBoundary from './components/RenderBoundary.jsx';
import Icon from './components/Icon.jsx';

const NAV = [
  { id: 'queue', label: 'Downloads', icon: 'download' },
  { id: 'add', label: 'Add music', icon: 'plus' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
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
      <SoundCues />
      <Sidebar view={view} setView={setView} downloadPath={config.downloadPath} />
      <main className="main">
        <RenderBoundary key={view}>
          {view === 'queue' && (
            <QueueView
              onToast={toast}
              preferences={config.queueView}
              onPreferencesChange={saveQueueView}
              onAddMusic={() => setView('add')}
            />
          )}
          {view === 'add' && <AddView onToast={toast} />}
          {view === 'settings' && (
            <SettingsView config={config} setConfig={setConfig} onToast={toast} throttleOff={throttleOff} />
          )}
        </RenderBoundary>
      </main>
      {/* Outside the view's RenderBoundary on purpose: a view that throws must
          not take the pause button and the live transfers down with it. */}
      <TransportBar onToast={toast} />
      <div className="toast-host">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.kind === 'err' ? ' err' : ''}`} role={t.kind === 'err' ? 'alert' : 'status'}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}

function Splash() {
  return (
    <div className="empty" style={{ height: '100%' }}>
      <div className="empty-icon"><Icon name="disc" size={24} /></div>
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
      <div className="empty-icon"><Icon name="alert" size={24} /></div>
      <h3>The download engine could not start</h3>
      <p>{String((error && error.message) || error)}</p>
      <div className="row-actions" style={{ marginTop: 16 }}>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>Try again</button>
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
 * transport bar renders, and the tray's own Pause comes back the other way.
 * Mounted once, next to the engine, rather than inside a view: a tray that
 * stopped updating because the user was looking at Settings would be worse
 * than no tray at all.
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

/**
 * Sound cues, driven from the numbers rather than from engine events so one
 * place decides when something is worth hearing about.
 *
 * This used to live inside the sidebar, which meant the nav component owned a
 * side effect that had nothing to do with navigation. It is its own null
 * component now, mounted beside TrayBridge for the same always-on reason.
 */
function SoundCues() {
  const stats = useStats();
  // The previous snapshot is a ref, not state: it is read and replaced inside
  // the effect and must never trigger a render of its own.
  const prev = useRef(stats);

  useEffect(() => {
    const p = prev.current;
    const changed = stats.completed + stats.skipped > p.completed + p.skipped;
    const nowIdle = stats.queued === 0 && stats.active === 0;
    if (changed && nowIdle && stats.total > 0) play('finished');
    else if (stats.completed > p.completed) play('complete');
    else if (stats.skipped > p.skipped) play('skipped');
    prev.current = stats;
  }, [stats]);

  return null;
}

function Sidebar({ view, setView, downloadPath }) {
  const stats = useStats();
  const counts = { queue: stats.queued + stats.active + (stats.paused || 0) };

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="mark" aria-hidden="true"><Icon name="music" size={15} strokeWidth={2.4} /></span>
        <span>Lucida Fetcher</span>
      </div>

      <nav className="nav" aria-label="Main">
        {NAV.map((n) => (
          <button
            key={n.id}
            className="nav-item"
            aria-current={view === n.id ? 'page' : undefined}
            onClick={() => setView(n.id)}
          >
            <Icon name={n.icon} size={17} />
            <span>{n.label}</span>
            {counts[n.id] > 0 && <span className="count">{counts[n.id]}</span>}
          </button>
        ))}
      </nav>

      {/* The one place the destination is always visible - "where did it put
          my files" is the most common question a downloader gets asked. */}
      <div className="sidebar-foot">
        <button
          type="button"
          className="folder-link"
          disabled={!isElectron || !downloadPath}
          onClick={() => ipc.invoke('open-path', downloadPath)}
          title={downloadPath ? `Open ${downloadPath}` : 'No download folder set'}
        >
          <Icon name="folder" size={15} />
          <span className="truncate">{downloadPath || 'No folder set'}</span>
        </button>
      </div>
    </aside>
  );
}
