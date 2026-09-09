import { useState } from 'react';
import { exportDiagnostics } from '../diagnostics.js';
import { isElectron, ipc, getController } from '../engine.js';
import { configureSounds, play } from '../sounds.js';
import SourceIcon from '../components/SourceIcon.jsx';
import { SERVICE_LABELS } from '../../engine/status.mjs';

const ALL_SERVICES = ['qobuz', 'tidal', 'deezer', 'amazon', 'yandex'];

export default function SettingsView({ config, setConfig, onToast }) {
  const [local, setLocal] = useState(config);
  const [notes, setNotes] = useState('');
  const [withPrevious, setWithPrevious] = useState(false);
  const [exporting, setExporting] = useState(false);

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

  const patch = (next) => {
    const merged = { ...local, ...next };
    setLocal(merged);
    setConfig(merged);
    if (isElectron) ipc.send('set-config', next);
    const controller = getController();
    if (controller && next.fallbackServices) controller.services = next.fallbackServices;
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

  const toggleFreeService = (sv) => {
    const cur = local.freeSources || ['jamendo'];
    const next = cur.includes(sv) ? cur.filter((s) => s !== sv) : [...cur, sv];
    const merged = patch({ freeSources: next });
    const controller = getController();
    if (controller) controller.planOptions.jamendo =
      next.includes('jamendo') && !!String(merged.jamendoClientId || '').trim();
  };

  return (
    <>
      <header className="topbar"><h1>Settings</h1></header>
      <div className="pane pane-narrow">

        <section className="card">
          <div className="card-head"><h2>Library</h2></div>
          <div className="card-body">
            <div className="field">
              <label htmlFor="dl-path">Download folder</label>
              <div className="row-actions">
                <input id="dl-path" className="input mono" readOnly value={local.downloadPath || ''} />
                <button className="btn" onClick={pickFolder} disabled={!isElectron}>Change…</button>
              </div>
              <span className="hint">Each playlist gets its own subfolder, alongside a report of what could not be found.</span>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Free sources</h2>
            <span className="spacer" style={{ flex: 1 }} />
            <span className="pill">artist-authorized</span>
          </div>
          <div className="card-body">
            <label className="switch">
              <input
                type="checkbox"
                checked={(local.freeSources || ['jamendo']).includes('jamendo')}
                onChange={() => toggleFreeService('jamendo')}
              />
              <span className="track" />
              <span>
                <div style={{ fontWeight: 550 }}>Jamendo</div>
                <div className="hint">Creative Commons music whose artists explicitly allow downloading.</div>
              </span>
            </label>
            <div className="field">
              <label htmlFor="jamendo-client">Jamendo client ID</label>
              <input
                id="jamendo-client"
                className="input mono"
                value={local.jamendoClientId || ''}
                placeholder="Get a free ID from developer.jamendo.com"
                onChange={(e) => {
                  const jamendoClientId = e.target.value.trim();
                  const merged = patch({ jamendoClientId });
                  const controller = getController();
                  if (controller) controller.planOptions.jamendo =
                    (merged.freeSources || ['jamendo']).includes('jamendo') && !!jamendoClientId;
                }}
              />
              <span className="hint">
                Create a non-commercial app at developer.jamendo.com. Jamendo is skipped until this is filled in;
                its public testing ID is deliberately not shipped.
              </span>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2>Downloading</h2></div>
          <div className="card-body">
            <div className="field">
              <label htmlFor="conc">Simultaneous downloads — {local.concurrency || 3}</label>
              <input
                id="conc" type="range" min="1" max="6" step="1"
                value={local.concurrency || 3}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  patch({ concurrency: n });
                  const c = getController();
                  if (c && c.setConcurrency) c.setConcurrency(n);
                }}
              />
              <span className="hint">
                Each one drives its own hidden browser page. Three is a good balance —
                the sites are free community services, and pushing much harder tends to
                trip rate limits, which costs more time than the extra lanes save.
              </span>
            </div>

            <div className="divider" />

            <div className="field">
              <label htmlFor="transfers">
                Transfers running ahead — {local.maxTransfers == null ? 3 : local.maxTransfers}
              </label>
              <input
                id="transfers" type="range" min="0" max="8" step="1"
                value={local.maxTransfers == null ? 3 : local.maxTransfers}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  patch({ maxTransfers: n });
                  const c = getController();
                  if (c) c.maxTransfers = n;
                }}
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
                value={local.speedLimitKBps || 0}
                onChange={(e) => patch({ speedLimitKBps: Number(e.target.value) || 0 })}
              />
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
              A track is first looked for on the store its own link points at. If that
              fails, these are tried in turn, then Monochrome, SoundCloud, and finally YouTube.
              SoundCloud search is included automatically. Changes apply to tracks that have not started.
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)' }}>
              {ALL_SERVICES.map((sv) => {
                const on = (local.fallbackServices || ['amazon']).includes(sv);
                return (
                  <button
                    key={sv}
                    className={`btn btn-sm ${on ? 'btn-primary' : ''}`}
                    onClick={() => toggleService(sv)}
                    aria-pressed={on}
                  >
                    <SourceIcon service={sv} size={20} title="" />{SERVICE_LABELS[sv] || sv}
                  </button>
                );
              })}
            </div>
            <span className="hint">
              Paste a SoundCloud track or playlist in Add music to download its exact uploads first.
              If a source is unavailable, the next source is tried automatically.
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
                  value={local.soundVolume ?? 0.35}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    patch({ soundVolume: v });
                    configureSounds({ volume: v });
                  }}
                  onMouseUp={() => play('complete')}
                />
              </div>
            )}
          </div>
        </section>

      </div>
    </>
  );
}
