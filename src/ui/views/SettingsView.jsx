import { useState } from 'react';
import { exportDiagnostics } from '../diagnostics.js';
import { isElectron, ipc, getController } from '../engine.js';
import { configureSounds, play } from '../sounds.js';
import SourceIcon from '../components/SourceIcon.jsx';
import { SERVICE_LABELS } from '../../engine/status.mjs';

const ALL_SERVICES = ['qobuz', 'tidal', 'deezer', 'amazon', 'yandex', 'monochrome'];

export default function SettingsView({ config, setConfig, onToast, throttleOff = false }) {
  const [local, setLocal] = useState(config);
  const [draftSpeed, setDraftSpeed] = useState(() => (config.speedLimitKBps != null ? String(config.speedLimitKBps) : '0'));
  const [notes, setNotes] = useState('');
  const [withPrevious, setWithPrevious] = useState(false);
  const [exporting, setExporting] = useState(false);

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
    if (dir) { patch({ downloadPath: dir }); onToast('Download folder updated.'); }
  };

  const toggleService = (sv) => {
    const cur = local.fallbackServices || ['amazon'];
    const next = cur.includes(sv) ? cur.filter((s) => s !== sv) : [...cur, sv];
    patch({ fallbackServices: next });
  };

  return (
    <>
      <header className="topbar">
        <div>
          <h1>Settings</h1>
          <span className="topbar-subtitle">Downloads land where you point them, at the speed you allow</span>
        </div>
      </header>

      <div className="pane settings-grid">
        <section className="card">
          <div className="card-head"><h2>Destination</h2></div>
          <div className="card-body">
            <div className="field">
              <label htmlFor="folder">Download folder</label>
              <div className="row-actions">
                <input
                  id="folder"
                  className="input"
                  readOnly
                  value={local.downloadPath || ''}
                  placeholder="Select a folder…"
                />
                <button className="btn" disabled={!isElectron} onClick={pickFolder}>
                  Browse…
                </button>
                <button
                  className="btn"
                  disabled={!isElectron || !local.downloadPath}
                  onClick={() => ipc.invoke('open-path', local.downloadPath)}
                >
                  Open
                </button>
              </div>
              <span className="hint">
                Every track lands inside this folder. A track downloaded as part of a
                playlist or album goes into its own subfolder underneath it.
              </span>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2>Downloading</h2></div>
          <div className="card-body">
            <div className="field">
              <label htmlFor="conc">Simultaneous downloads — {rangeValue('concurrency', 3)}</label>
              <input
                id="conc" type="range" min="1" max="6" step="1"
                value={rangeValue('concurrency', 3)}
                onChange={onRangeDrag('concurrency')}
                onPointerUp={onRangeCommit('concurrency', (n) => {
                  const c = getController();
                  if (c && c.setConcurrency) c.setConcurrency(n);
                })}
                onKeyUp={onRangeCommit('concurrency', (n) => {
                  const c = getController();
                  if (c && c.setConcurrency) c.setConcurrency(n);
                })}
                onBlur={onRangeCommit('concurrency', (n) => {
                  const c = getController();
                  if (c && c.setConcurrency) c.setConcurrency(n);
                })}
              />
              <span className="hint">
                Each one drives its own hidden browser page. Three is a good balance —
                the sites are free community services, and pushing much harder tends to
                trip rate limits, which costs more time than the extra lanes save.
              </span>
            </div>

            <div className="divider" />

            <label className="switch">
              <input type="checkbox" checked={!!local.keepTrying}
                onChange={(e) => patch({ keepTrying: e.target.checked })} />
              <span className="track" />
              <span>
                <div style={{ fontWeight: 550 }}>Keep trying</div>
                <div className="hint">After all searches and downloads finish, automatically retry missing tracks. Waits 30 seconds between passes, increasing to 5 minutes for repeated failures. Pause or cancel all to stop retries.</div>
              </span>
            </label>

            <div className="divider" />

            <div className="field">
              <label htmlFor="transfers">
                Transfers running ahead — {rangeValue('maxTransfers', 6)}
              </label>
              <input
                id="transfers" type="range" min="0" max="8" step="1"
                value={rangeValue('maxTransfers', 6)}
                onChange={onRangeDrag('maxTransfers')}
                onPointerUp={onRangeCommit('maxTransfers', (n) => {
                  const c = getController();
                  if (c) c.maxTransfers = n;
                })}
                onKeyUp={onRangeCommit('maxTransfers', (n) => {
                  const c = getController();
                  if (c) c.maxTransfers = n;
                })}
                onBlur={onRangeCommit('maxTransfers', (n) => {
                  const c = getController();
                  if (c) c.maxTransfers = n;
                })}
              />
              <span className="hint">
                Searching and downloading use different things — a hidden page for the
                first, the network for the second — so a page does not have to sit and
                watch a file arrive. This is how many files may still be arriving while
                their pages have moved on to search the next tracks. At 0 a page waits
                for its own file, which is the old behaviour.
              </span>
            </div>

            <div className="divider" />

            <div className="field">
              <label htmlFor="speed">Speed limit (KB/s, 0 = unlimited)</label>
              <input
                id="speed" className="input" type="number" min="0"
                value={draftSpeed}
                onChange={(e) => setDraftSpeed(e.target.value)}
                onBlur={commitSpeed}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              />
              {throttleOff && (
                // Saying nothing here is how the limiter used to disable itself
                // for the rest of the session while this field went on showing a
                // number that no longer did anything.
                <span className="hint" style={{ color: 'var(--warn, #e0b341)' }}>
                  Not being applied: a server in this session restarted its transfer
                  whenever it was paused, so the limiter turned itself off to avoid a
                  download that could never finish. Restart the app to try again.
                </span>
              )}
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Sources</h2>
            <span className="spacer" style={{ flex: 1 }} />
            <span className="pill">tried in order</span>
          </div>
          <div className="card-body">
            <span className="hint" style={{ marginTop: -4 }}>
              Only enabled sources are checked, in the order you select them.
              Downloads must be FLAC. YouTube and SoundCloud are never download sources.
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)' }}>
              {ALL_SERVICES.map((sv) => {
                const list = local.fallbackServices || ['amazon'];
                const idx = list.indexOf(sv);
                const on = idx !== -1;
                return (
                  <button
                    key={sv}
                    className={`btn btn-sm ${on ? 'btn-primary' : ''}`}
                    onClick={() => toggleService(sv)}
                    aria-pressed={on}
                    title={on ? `Priority #${idx + 1} — click to disable` : 'Click to enable'}
                  >
                    <SourceIcon service={sv} size={20} title="" />{SERVICE_LABELS[sv] || sv}
                    {on && <span style={{ marginLeft: 6, fontSize: '0.85em', opacity: 0.85, fontWeight: 700 }}>#{idx + 1}</span>}
                  </button>
                );
              })}
            </div>
            <span className="hint">
              Imported links identify tracks to search for on your enabled sources.
              If no enabled source provides FLAC, the track is marked missing.
            </span>
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2>Diagnostics</h2></div>
          <div className="card-body">
            <p className="hint" style={{ marginTop: 0 }}>
              Everything the app does is written to a session log. This turns that log into a
              single readable report — what failed, which sources answered, and the exact
              chain of sources tried for every track that did not download — with the raw
              events underneath it.
            </p>
            <div className="field">
              <label htmlFor="diag-notes">What were you doing? (optional)</label>
              <input
                id="diag-notes"
                className="input"
                placeholder="e.g. downloaded a profile, half the tracks came back missing"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <div className="hint">
                The one thing no amount of logging can recover, and the first thing anyone
                reading the report wants to know.
              </div>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={withPrevious}
                onChange={(e) => setWithPrevious(e.target.checked)}
              />
              <span className="track" />
              <span>
                <div style={{ fontWeight: 550 }}>Include the last 3 sessions</div>
                <div className="hint">For a problem that also happened yesterday. Off by default — a bigger report is a slower read.</div>
              </span>
            </label>
            <div className="row-actions" style={{ marginTop: 'var(--s3)' }}>
              <button className="btn btn-primary" disabled={!isElectron || exporting} onClick={saveReport}>
                {exporting ? 'Building report…' : '↓ Export diagnostics report'}
              </button>
              <button className="btn" disabled={!isElectron} onClick={() => ipc.invoke('open-log-folder')}>
                Open logs folder
              </button>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2>Window</h2></div>
          <div className="card-body">
            <label className="switch">
              <input
                type="checkbox"
                checked={local.closeToTray !== false}
                onChange={(e) => patch({ closeToTray: e.target.checked })}
              />
              <span className="track" />
              <span>
                <div style={{ fontWeight: 550 }}>Keep running in the tray when the window is closed</div>
                <div className="hint">
                  A queue is measured in hours, so closing the window hides it instead of ending
                  the run — the tray icon opens it again, and its menu can pause or quit.
                  Turn this off to make the close button quit the app outright.
                </div>
              </span>
            </label>
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2>Sounds</h2></div>
          <div className="card-body">
            <label className="switch">
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
              <span>
                <div style={{ fontWeight: 550 }}>Play a sound on each result</div>
                <div className="hint">
                  A short rising cue when a track lands, a falling one when a track cannot
                  be found, and a longer one when the whole queue finishes. Off by default.
                </div>
              </span>
            </label>

            {local.sounds && (
              <div className="field">
                <label htmlFor="vol">Volume</label>
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
              </div>
            )}
          </div>
        </section>

      </div>
    </>
  );
}
