import { useMemo } from 'react';
import { useItems, useTransferProgress } from '../engine.js';
import { serviceLabel } from '../../engine/status.mjs';
import { displayedService } from '../../engine/source-display.mjs';
import SourceIcon from './SourceIcon.jsx';
import Icon from './Icon.jsx';

// Further along the chain sorts first: a transfer is closer to "done" than a
// search, and the thing the user is most likely waiting on belongs on top.
const ORDER = { downloading: 0, ready: 1, fetching: 2, searching: 3 };
const PHASE = { downloading: 'Downloading', ready: 'Ready', fetching: 'Fetching', searching: 'Searching' };
// The sidebar scrolls, but past this a column of identical spinners stops
// saying anything; the rest is one click away in Downloads.
const MAX_ROWS = 12;

/**
 * What the engine is working on right now, as a live list under the nav.
 *
 * Replaces "Searching 3 tracks…" in the transport bar as the place to see
 * activity: a count said nothing about *which* tracks, and the Downloads view
 * buries the busy rows among hundreds of queued ones. Derived from the item
 * list on structural changes only - byte ticks are subscribed per downloading
 * row (DownloadLine), never here, so a search finishing re-renders this list
 * but a progress tick does not.
 */
export default function SidebarActivity({ onOpen }) {
  const items = useItems();

  const live = useMemo(() => {
    // Keyed by item id: the same track can sit in two playlists, and the engine
    // reports both records while one webview does the work.
    const seen = new Map();
    for (const rec of items) {
      if (ORDER[rec.status] === undefined) continue;
      if (!seen.has(rec.item.id)) seen.set(rec.item.id, rec);
    }
    // Array.prototype.sort is stable, so ties keep queue order instead of
    // shuffling every time a status changes elsewhere.
    return [...seen.values()].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  }, [items]);

  if (!live.length) return null;

  const shown = live.slice(0, MAX_ROWS);
  return (
    <section className="activity" aria-label="Now working">
      <header className="activity-head">
        <span className="live-dot" aria-hidden="true" />
        <span>Now working</span>
        <span className="activity-count">{live.length}</span>
      </header>
      <ul className="activity-list">
        {shown.map((rec) => <ActivityRow key={rec.item.id} rec={rec} onOpen={onOpen} />)}
      </ul>
      {live.length > MAX_ROWS && (
        <button type="button" className="activity-more" onClick={onOpen}>
          +{live.length - MAX_ROWS} more in Downloads
        </button>
      )}
    </section>
  );
}

function ActivityRow({ rec, onOpen }) {
  const { item, status } = rec;
  const title = item.title || item.name;
  const service = displayedService(rec);
  const searching = status === 'searching' || status === 'fetching';
  return (
    <li>
      <button
        type="button"
        className={`activity-row ${status}`}
        onClick={onOpen}
        // The full status sentence ("Qobuz found it but could not supply the
        // audio") lives in the tooltip: the row has room for a phase, not a reason.
        title={`${title}${item.artist ? ' — ' + item.artist : ''}\n${rec.statusText || PHASE[status]}`}
      >
        <span className={`activity-art${searching ? ' spinning' : ''}`}>
          {item.image
            ? <img src={item.image} alt="" referrerPolicy="no-referrer" />
            : <Icon name="music" size={13} />}
        </span>
        <span className="activity-copy">
          <span className="activity-title truncate">{title}</span>
          {status === 'downloading'
            ? <DownloadLine rec={rec} />
            : (
              <span className="activity-sub">
                {service && <SourceIcon service={service} size={12} />}
                <span className="truncate">{PHASE[status]}{service ? ` ${serviceLabel(service)}` : ''}</span>
              </span>
            )}
        </span>
      </button>
    </li>
  );
}

/** The only part of a row that re-renders per byte tick. */
function DownloadLine({ rec }) {
  useTransferProgress(); // rec is mutated in place; this just schedules the re-read
  const pct = typeof rec.progress === 'number' ? Math.round(rec.progress * 100) : null;
  return (
    <span className="activity-progress">
      <span className={`progress${pct === null ? ' indeterminate' : ''}`}>
        <i style={{ width: pct === null ? undefined : `${pct}%` }} />
      </span>
      <span className="activity-pct">{pct === null ? '' : `${pct}%`}</span>
    </span>
  );
}
