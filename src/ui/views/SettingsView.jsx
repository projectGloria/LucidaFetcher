import { useState } from 'react';
import { exportDiagnostics } from '../diagnostics.js';
import { isElectron, ipc, getController } from '../engine.js';
import { configureSounds, play } from '../sounds.js';
import SourceIcon from '../components/SourceIcon.jsx';
import Icon from '../components/Icon.jsx';
import { SERVICE_LABELS } from '../../engine/status.mjs';
import { normalizeApiUrl } from '../../engine/source-access.mjs';

const ALL_SERVICES = ['qobuz', 'tidal', 'deezer', 'amazon', 'yandex', 'monochrome'];

export default function SettingsView({ config, setConfig, onToast, throttleOff = false }) {
  const [local, setLocal] = useState(config);
  const [draftSpeed, setDraftSpeed] = useState(() => (config.speedLimitKBps != null ? String(config.speedLimitKBps) : '0'));
  const [notes, setNotes] = useState('');
  const [withPrevious, setWithPrevious] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [apiDraft, setApiDraft] = useState(config.monochromeApiUrl || '');
  const [apiError, setApiError] = useState('');
  const commitApi = () => {
    try {
      const url = normalizeApiUrl(apiDraft);
      setApiError('');
      setApiDraft(url);
      if (url === (local.monochromeApiUrl || '')) return;
      getController()?.setMonochromeApiUrl?.(url);
      patch({ monochromeApiUrl: url });
      onToast('Monochrome backend updated for the next search.');
    } catch (error) { setApiError(error.message); }
  };

  const commitSpeed = () => {
    const trimmed = draftSpeed.trim();
    const val = trimmed === '' ? 0 : Math.max(0, parseInt(trimmed, 10) || 0);
    setDraftSpeed(String(val));
    if (val !== (local.speedLimitKBps || 0)) {
      patch({ speedLimitKBps: val });
    }
  };

  const saveReport = async () => {
    if (!isElectron || exporting) return;
    setExporting(true);
    try {
      const res = await exportDiagnostics(ipc, { notes: notes.trim() || null, includePrevious: withPrevious ? 3 : 0 });
      if (res.cancelled) return;
      if (!res.ok) { onToast(res.message || 'Could not write the report.', 'err'); return; }
      const s = res.summary;
      const missing = s.tracks.filter((t) => t.result !== 'downloaded').length;
      // The toast says what is IN the report, not just that a file appeared:
      // the whole point is to know whether it captured the thing you hit.
      onToast(`Report saved — ${res.events} events, ${s.counts.error} errors, ${missing} unfinished tracks.`);
    } catch (error) {
      onToast(error.message || 'Could not build the report.', 'err');
    } finally { setExporting(false); }
  };

  // A range input fires onChange for EVERY step of a drag, and committing there
  // meant a config write, a log line and a pool rebuild at each intermediate
  // value - and dragging the concurrency slider down and back up handed a live
  // slot to a second chain. The label follows the drag; the commit waits for
  // the release.
  const [dragging, setDragging] = useState({});
  const rangeValue = (key, fallback) => (
    dragging[key] != null ? dragging[key] : (local[key] == null ? fallback : local[key])
  );
  const onRangeDrag = (key) => (e) => {
    const n = Number(e.target.value);
    setDragging((d) => ({ ...d, [key]: n }));
  };
  const onRangeCommit = (key, apply) => () => {
    const n = dragging[key];
    setDragging((d) => { const rest = { ...d }; delete rest[key]; return rest; });
    if (n == null || n === local[key]) return;
    patch({ [key]: n });
    if (apply) apply(n);
  };
  // Pointer release, keyboard release and blur all commit - whichever ends the
  // interaction first. Spread onto each slider rather than repeated three times.
  const commitOn = (key, apply) => {
    const commit = onRangeCommit(key, apply);
    return { onPointerUp: commit, onKeyUp: commit, onBlur: commit };
  };

  const patch = (next) => {
    const merged = { ...local, ...next };
    setLocal(merged);
    setConfig(merged);
    if (isElectron) ipc.send('set-config', next);
    const controller = getController();
    if (controller && next.fallbackServices) {
      if (controller.setServices) controller.setServices(next.fallbackServices);
      else controller.services = next.fallbackServices;
    }
    if (controller && 'keepTrying' in next) controller.setKeepTrying?.(next.keepTrying);
    return merged;
  };

  const pickFolder = async () => {
    if (!isElectron) return;
    const dir = await ipc.invoke('select-directory');
    if (dir) {
      patch({ downloadPath: dir });
      getController()?.recheckExisting?.();
      onToast('Download folder updated.');
    }
  };

  const toggleService = (sv) => {
    const cur = local.fallbackServices || ['amazon'];
    const next = cur.includes(sv) ? cur.filter((s) => s !== sv) : [...cur, sv];
    patch({ fallbackServices: next });
  };

  const setConcurrency = (n) => { const c = getController(); if (c && c.setConcurrency) c.setConcurrency(n); };
  const setMaxTransfers = (n) => { const c = getController(); if (c) c.maxTransfers = n; };
  const services = local.fallbackServices || ['amazon'];

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Settings</h1>
          <span className="topbar-sub">Saved as you change them</span>
        </div>
      </header>

      <div className="pane">
        <div className="settings">
          <section className="settings-section">
            <h2>Library</h2>
            <div className="settings-card">
              <div className="setting-block">
                <div className="setting-copy">
                  <label className="setting-title" htmlFor="folder">Download folder</label>
                  <span className="setting-desc">Playlists and albums each get their own subfolder inside it.</span>
                </div>
                <div className="path-ctl">
                  <input id="folder" className="input" readOnly value={local.downloadPath || ''} placeholder="Select a folder…" />
                  <button className="btn" disabled={!isElectron} onClick={pickFolder}>Browse…</button>
                  <button className="btn btn-icon" disabled={!isElectron || !local.downloadPath}
                    onClick={() => ipc.invoke('open-path', local.downloadPath)} title="Open folder" aria-label="Open folder">
                    <Icon name="folder" size={16} />
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h2>Downloading</h2>
            <div className="settings-card">
              <div className="setting-row">
                <div className="setting-copy">
                  <label className="setting-title" htmlFor="conc">Simultaneous searches</label>
                  <span className="setting-desc">
                    Each has a hidden browser page. Searches on the same site take turns,
                    with shared pacing and cooldowns when the site limits requests.
                  </span>
                </div>
                <div className="setting-ctl range-ctl">
                  <input id="conc" type="range" min="1" max="6" step="1"
                    value={rangeValue('concurrency', 3)}
                    onChange={onRangeDrag('concurrency')}
                    {...commitOn('concurrency', setConcurrency)} />
                  <span className="value-badge">{rangeValue('concurrency', 3)}</span>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-copy">
                  <label className="setting-title" htmlFor="transfers">Transfers running ahead</label>
                  <span className="setting-desc">
                    Files that keep downloading while their page moves on to the next search.
                    0 makes each page wait for its own file.
                  </span>
                </div>
                <div className="setting-ctl range-ctl">
                  <input id="transfers" type="range" min="0" max="8" step="1"
                    value={rangeValue('maxTransfers', 6)}
                    onChange={onRangeDrag('maxTransfers')}
                    {...commitOn('maxTransfers', setMaxTransfers)} />
                  <span className="value-badge">{rangeValue('maxTransfers', 6)}</span>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-copy">
                  <label className="setting-title" htmlFor="speed">Speed limit</label>
                  {throttleOff ? (
                    // Saying nothing here is how the limiter used to disable itself
                    // for the rest of the session while this field went on showing a
                    // number that no longer did anything.
                    <span className="setting-desc warn-text">
                      Not being applied: a server in this session restarted its transfer whenever
                      it was paused, so the limiter switched itself off. Restart the app to try again.
                    </span>
                  ) : (
                    <span className="setting-desc">Total across all transfers. 0 means unlimited.</span>
                  )}
                </div>
                <div className="setting-ctl suffix-input">
                  <input
                    id="speed" className="input" type="number" min="0"
                    value={draftSpeed}
                    onChange={(e) => setDraftSpeed(e.target.value)}
                    onBlur={commitSpeed}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  />
                  <span>KB/s</span>
                </div>
              </div>

              <label className="switch setting-row">
                <span className="setting-copy">
                  <span className="setting-title">Keep trying</span>
                  <span className="setting-desc">
                    Retry missing tracks after the queue finishes — every 30 seconds at first,
                    backing off to 5 minutes. Pause or Cancel all stops it.
                  </span>
                </span>
                <span className="switch-ctl">
                  <input type="checkbox" checked={!!local.keepTrying}
                    onChange={(e) => patch({ keepTrying: e.target.checked })} />
                  <span className="track" />
                </span>
              </label>
            </div>
          </section>

          <section className="settings-section">
            <h2>Sources</h2>
            <div className="settings-card">
              <div className="setting-block">
                <div className="setting-copy">
                  <span className="setting-title">Where to look, in order</span>
                  <span className="setting-desc">
                    Click to enable; the number is the order they are tried. Only FLAC is accepted —
                    a track no enabled source has is marked missing.
                  </span>
                </div>
                <div className="source-chips">
                  {ALL_SERVICES.map((sv) => {
                    const idx = services.indexOf(sv);
                    const on = idx !== -1;
                    return (
                      <button
                        key={sv}
                        className="source-chip"
                        onClick={() => toggleService(sv)}
                        aria-pressed={on}
                        title={on ? `Tried #${idx + 1} — click to disable` : 'Click to enable'}
                      >
                        <SourceIcon service={sv} size={20} title="" />
                        {SERVICE_LABELS[sv] || sv}
                        {on && <span className="source-rank">{idx + 1}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="setting-block">
                <div className="setting-copy">
                  <label className="setting-title" htmlFor="monochrome-api">Monochrome custom API</label>
                  <span className="setting-desc">Optional compatible HiFi API you operate or have access to. Leave blank for Monochrome's default service. Its own limits still apply.</span>
                </div>
                <div className="path-ctl">
                  <input id="monochrome-api" className="input" type="url" placeholder="http://127.0.0.1:8000"
                    value={apiDraft} aria-invalid={!!apiError} aria-describedby={apiError ? 'monochrome-api-error' : undefined}
                    onChange={e => setApiDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') commitApi(); }} />
                  <button className="btn" onClick={commitApi}>Apply</button>
                </div>
                {apiError && <span id="monochrome-api-error" className="setting-desc warn-text" role="alert">{apiError}</span>}
                <span className="setting-desc">Lucida remembers working regions per provider automatically. Country selection does not change your connection's location.</span>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h2>App</h2>
            <div className="settings-card">
              <label className="switch setting-row">
                <span className="setting-copy">
                  <span className="setting-title">Keep running in the tray when the window is closed</span>
                  <span className="setting-desc">
                    Closing hides the window instead of ending the run. Turn off to make close quit.
                  </span>
                </span>
                <span className="switch-ctl">
                  <input type="checkbox" checked={local.closeToTray !== false}
                    onChange={(e) => patch({ closeToTray: e.target.checked })} />
                  <span className="track" />
                </span>
              </label>

              <label className="switch setting-row">
                <span className="setting-copy">
                  <span className="setting-title">Play a sound on each result</span>
                  <span className="setting-desc">
                    A rising cue when a track lands, a falling one when it cannot be found,
                    and a longer one when the queue finishes.
                  </span>
                </span>
                <span className="switch-ctl">
                  <input
                    type="checkbox"
                    checked={!!local.sounds}
                    onChange={(e) => {
                      const on = e.target.checked;
                      patch({ sounds: on });
                      configureSounds({ enabled: on });
                      if (on) play('complete'); // confirm audibly, on the click that enabled it
                    }}
                  />
                  <span className="track" />
                </span>
              </label>

              {local.sounds && (
                <div className="setting-row">
                  <div className="setting-copy">
                    <label className="setting-title" htmlFor="vol">Volume</label>
                  </div>
                  <div className="setting-ctl range-ctl">
                    <input
                      id="vol" type="range" min="0" max="1" step="0.05"
                      value={rangeValue('soundVolume', 0.35)}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setDragging((d) => ({ ...d, soundVolume: v }));
                        configureSounds({ volume: v });
                      }}
                      onPointerUp={onRangeCommit('soundVolume', () => play('complete'))}
                      onKeyUp={onRangeCommit('soundVolume', () => play('complete'))}
                      onBlur={onRangeCommit('soundVolume')}
                    />
                    <span className="value-badge">{Math.round(rangeValue('soundVolume', 0.35) * 100)}</span>
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="settings-section">
            <h2>Diagnostics</h2>
            <div className="settings-card">
              <div className="setting-block">
                <div className="setting-copy">
                  <label className="setting-title" htmlFor="diag-notes">Export a report</label>
                  <span className="setting-desc">
                    Turns the session log into one readable file: what failed, which sources answered,
                    and every source tried for each track that did not download.
                  </span>
                </div>
                <input
                  id="diag-notes"
                  className="input"
                  placeholder="What were you doing? e.g. downloaded a profile, half came back missing"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
                <label className="switch">
                  <span className="switch-ctl">
                    <input type="checkbox" checked={withPrevious} onChange={(e) => setWithPrevious(e.target.checked)} />
                    <span className="track" />
                  </span>
                  <span className="setting-desc" style={{ marginTop: 0 }}>Include the last 3 sessions</span>
                </label>
                <div className="row-actions">
                  <button className="btn btn-primary" disabled={!isElectron || exporting} onClick={saveReport}>
                    <Icon name="file" size={15} />{exporting ? 'Building report…' : 'Export report'}
                  </button>
                  <button className="btn btn-ghost" disabled={!isElectron} onClick={() => ipc.invoke('open-log-folder')}>
                    Open logs folder
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
