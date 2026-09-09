import { useMemo, useState, useSyncExternalStore } from 'react';
import { getController, isElectron, ipc, sources } from '../engine.js';
import * as history from '../history.js';
import { buildSearchVariants, buildSearchQuery } from '../../engine/variants.mjs';
import { sanitizeFolder, joinFolder, sortPlaylists, PROFILE_ORDERS, mapPool } from '../../engine/sources.mjs';

let seq = 0;
const MODES = [
  { id: 'search', label: 'Search tracks', icon: '⌕' },
  { id: 'link', label: 'Paste a link', icon: '↗' },
  { id: 'profile', label: 'Spotify profile', icon: '◎' },
  { id: 'history', label: 'History', icon: '⟲' },
];
const DEMO_RESULTS = [
  { title: 'After Dark', uploader: 'Mr.Kitty', durationSec: 259, url: 'https://www.youtube.com/watch?v=sVx1mJDeUjY', source: 'youtube' },
  { title: 'After Dark (Official Audio)', uploader: 'Mr.Kitty Official', durationSec: 257, url: 'https://soundcloud.com/mrkittydm/after-dark', source: 'soundcloud' },
  { title: 'After Dark x Sweater Weather', uploader: 'mashups', durationSec: 281, url: 'https://www.youtube.com/watch?v=example2', source: 'youtube' },
  { title: 'After Dark — slowed', uploader: 'nightdrive', durationSec: 301, url: 'https://soundcloud.com/example/after-dark', source: 'soundcloud' },
];

function mediaService(url) {
  if (/soundcloud\.com|snd\.sc/i.test(url || '')) return 'soundcloud';
  if (/youtu\.?be/i.test(url || '')) return 'youtube';
  return null;
}

function toQueueItem({ title, artist, image, folderName, group, mediaUrl, durationSec, profile }) {
  return {
    id: `add-${Date.now()}-${seq++}`,
    title, artist,
    name: `${artist || 'Unknown artist'} - ${title}`,
    image: image || null,
    folderName: folderName || null,
    mediaUrl: mediaUrl || null,
    mediaService: mediaUrl ? mediaService(mediaUrl) : null,
    durationSec: durationSec || null,
    groupId: group ? group.id : null,
    groupName: group ? group.name : null,
    groupArtwork: group ? group.artworkUrl : null,
    // Carried on the item rather than held in a side table: the queue is
    // persisted and restored track by track, so anything the Downloads view
    // needs to rebuild the profile - playlist - track tree has to survive that
    // round trip on the track itself.
    profileId: profile ? profile.id : null,
    profileName: profile ? profile.name : null,
    profileUser: profile ? profile.user : null,
    profileService: profile ? profile.service : null,
    profileArtwork: profile ? profile.image : null,
    profileFolder: profile ? profile.folderName : null,
    profileOrder: profile ? profile.order : null,
    originalService: 'qobuz',
    searchQuery: buildSearchQuery(title, artist),
    searchVariants: buildSearchVariants(title, artist),
    key: `${folderName || ''}|${title}|${artist}`.toLowerCase(),
  };
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

function artworkFor(result) {
  if (result.thumbnail || result.image) return result.thumbnail || result.image;
  const match = /[?&]v=([^&]+)/.exec(result.url || '');
  return result.source === 'youtube' && match ? `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg` : null;
}

async function withoutExisting(items) {
  if (!isElectron || !items.length) return { items, skipped: 0 };
  try {
    const checks = await ipc.invoke('downloads-check', items.map((i) => ({ key: i.key, folderName: i.folderName, title: i.title })));
    return { items: items.filter((_, i) => !(checks[i] && checks[i].done)), skipped: checks.filter((r) => r && r.done).length };
  } catch { return { items, skipped: 0 }; }
}

function EmptyArtwork({ kind = 'track' }) {
  return <div className="media-placeholder" aria-hidden="true">{kind === 'playlist' ? '♫' : '♪'}</div>;
}

function SourceBadge({ source }) {
  return <span className={`source-badge ${source || ''}`}>{source === 'soundcloud' ? 'SoundCloud' : 'YouTube'}</span>;
}

function TrackCard({ result, action, actionLabel = 'Add to queue', queued = false, disabled = false, onOpen }) {
  const art = artworkFor(result);
  const length = formatDuration(result.durationSec);
  const isSet = !!result.isSet && !!onOpen;
  const cover = (
    <div className="media-cover">
      {art ? <img src={art} alt="" loading="lazy" /> : <EmptyArtwork kind={isSet ? 'playlist' : 'track'} />}
      {length && <span className="duration">{length}</span>}
      {isSet && <span className="set-badge">Album</span>}
      {result.source && <SourceBadge source={result.source} />}
    </div>
  );
  return (
    <article className={`media-card${isSet ? ' is-set' : ''}`}>
      {isSet
        ? <button type="button" className="cover-button" onClick={onOpen} disabled={disabled} aria-label={`Open ${result.title}`}>{cover}</button>
        : cover}
      <div className="media-details">
        <h3 title={result.title}>{result.title}</h3>
        <p title={result.uploader || result.artist}>{result.uploader || result.artist || 'Unknown artist'}</p>
        {isSet
          ? <div className="card-actions">
              <button className="btn card-action" onClick={onOpen} disabled={disabled}>⤢ Open</button>
              <button className="btn card-action primary-ghost" onClick={action} disabled={disabled}>＋ Add all</button>
            </div>
          : <button className={`btn card-action${queued ? ' queued' : ''}`} onClick={action} disabled={disabled || queued}>
              {queued ? '✓ Queued' : `＋ ${actionLabel}`}
            </button>}
      </div>
    </article>
  );
}

/** A set inside a set - a /albums link lists albums, not tracks - opened in
 *  place so the user can see what is in one before queueing any of it. */
function SetModal({ state, onClose, onQueueAll, onQueueOne, busy }) {
  const rows = state.preview?.results || [];
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={state.title} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div className="playlist-identity">
            {state.preview?.group?.artworkUrl || state.image
              ? <img src={state.preview?.group?.artworkUrl || state.image} alt="" />
              : <EmptyArtwork kind="playlist" />}
            <div>
              <span className="eyebrow">{state.loading ? 'Reading…' : 'Album'}</span>
              <h2>{state.preview?.name || state.title}</h2>
              {!state.loading && !state.error && <p>{rows.length} tracks</p>}
            </div>
          </div>
          <div className="modal-actions">
            {!state.loading && !state.error && !!rows.length &&
              <button className="btn btn-primary" onClick={onQueueAll} disabled={!!busy}>＋ Add all {rows.length}</button>}
            <button className="btn" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </header>
        <div className="modal-body">
          {state.loading && <div className="media-grid skeleton-grid">{Array.from({ length: 6 }, (_, i) => <div className="media-card skeleton" key={i} />)}</div>}
          {state.error && <div className="inline-empty"><strong>Could not open that album</strong><span>{state.error}</span></div>}
          {!state.loading && !state.error && <div className="media-grid">{rows.map((r, i) => (
            <TrackCard key={`${r.texts[0]}-${i}`} actionLabel="Add track" disabled={!!busy}
              result={{ title: r.texts[0], artist: r.texts[1] || '', image: r.image, durationSec: r.durationSec }}
              action={() => onQueueOne(r)} />
          ))}</div>}
        </div>
      </div>
    </div>
  );
}

// Past searches and pasted links, newest first, one entry per distinct query so
// searching the same thing twice moves it up rather than filling the list. A
// link entry keeps no results: re-opening it goes back through the resolve
// cache, which already holds them and is the only copy that stays correct.
// Day buckets rather than raw timestamps: "which afternoon was that" is the
// question someone actually brings to a history list.
function dayLabel(at) {
  const d = new Date(at);
  const today = new Date();
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(today) - midnight(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

function groupByDay(list) {
  const groups = [];
  for (const entry of list) {
    const label = dayLabel(entry.at);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}

function HistoryEntry({ entry, onOpen, onForget, busy }) {
  return (
    <article className="history-row">
      <div className="history-art">
        {entry.image ? <img src={entry.image} alt="" loading="lazy" /> : <EmptyArtwork kind={entry.kind === 'link' ? 'playlist' : 'track'} />}
      </div>
      <div className="history-copy">
        <h3 title={entry.name || entry.label}>{entry.name || entry.label}</h3>
        <p>
          <span className={`history-kind ${entry.kind}`}>
          {entry.kind === 'search' ? 'Search' : entry.kind === 'profile' ? 'Profile' : 'Link'}
        </span>
          {entry.count ? ` · ${entry.count} ${entry.kind === 'profile'
            ? (entry.count === 1 ? 'playlist' : 'playlists')
            : (entry.count === 1 ? 'result' : 'results')}` : ''}
          {entry.kind === 'link' ? ` · ${entry.label.replace(/^https?:\/\//, '').slice(0, 60)}` : ''}
        </p>
      </div>
      <div className="history-actions">
        <button className="btn" onClick={onOpen} disabled={!!busy}>Open again</button>
        <button className="btn subtle" onClick={onForget} aria-label="Remove from history">✕</button>
      </div>
    </article>
  );
}

export default function AddView({ onToast }) {
  const [mode, setMode] = useState('search');
  const [query, setQuery] = useState('');
  const [link, setLink] = useState('');
  const [profileName, setProfileName] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(null);
  const [results, setResults] = useState([]);
  const [searchState, setSearchState] = useState('idle');
  const [preview, setPreview] = useState(null);
  const [profile, setProfile] = useState(null);
  const [order, setOrder] = useState('default');
  const [queued, setQueued] = useState(new Set());
  const [setModal, setSetModal] = useState(null);
  useSyncExternalStore(history.subscribe, history.getSnapshot);
  const entries = history.list();

  const resultKey = (r) => r.url || `${r.title}|${r.uploader || r.artist}`;
  const safeFolder = folder.trim() ? sanitizeFolder(folder.trim()) : null;

  const queueItems = async (items, label, quiet = false) => {
    const { items: keep, skipped } = await withoutExisting(items);
    const controller = getController();
    const n = controller.add(keep);
    const dupes = (controller.lastAdd && controller.lastAdd.duplicates) || 0;
    // Worth saying out loud: a playlist that lists a track twice looks like the
    // app lost tracks unless the collapse is reported.
    const dupeNote = dupes ? ` ${dupes} duplicate${dupes === 1 ? '' : 's'} collapsed.` : '';
    if (quiet) return n;
    if (n === 1) {
      const item = keep[0];
      onToast(`Added “${item.title}”${item.artist ? ` by ${item.artist}` : ''} to the queue.${dupeNote}`);
    } else if (n > 1) {
      onToast(`Added ${n} tracks${label ? ` from ${label}` : ''} to the queue.${dupeNote}`);
    }
    else if (dupes) onToast(`Already queued.${dupeNote}`);
    else if (skipped) onToast(`${skipped === 1 ? 'That track is' : 'Those tracks are'} already downloaded.`);
    else onToast('Nothing new was added.');
    return n;
  };

  const search = async (event) => {
    event.preventDefault();
    const q = query.trim();
    if (!q || busy) return;
    setBusy('Searching YouTube and SoundCloud…');
    setSearchState('loading');
    setResults([]);
    setQueued(new Set());
    try {
      if (!isElectron) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        setResults(DEMO_RESULTS.map((r, i) => ({ ...r, title: i ? r.title : q })));
        setSearchState('done');
        return;
      }
      const [yt, sc] = await Promise.all([
        ipc.invoke('yt-search', { query: q, limit: 8 }),
        ipc.invoke('sc-search', { query: q, limit: 8 }),
      ]);
      const found = [
        ...((yt?.ok ? yt.results : []) || []).map((r) => ({ ...r, source: 'youtube' })),
        ...((sc?.ok ? sc.results : []) || []).map((r) => ({ ...r, source: 'soundcloud' })),
      ];
      const unique = [...new Map(found.map((r) => [resultKey(r), r])).values()];
      setResults(unique);
      setSearchState('done');
      if (unique.length) {
        history.remember({ kind: 'search', label: q, name: q, count: unique.length,
                   image: artworkFor(unique[0]) || '', results: unique, folder: safeFolder });
      }
      if (!unique.length && (!yt?.ok || !sc?.ok)) onToast('Search providers are unavailable right now. Try again in a moment.', 'err');
    } catch (error) {
      setSearchState('error');
      onToast(error.message || 'Search failed.', 'err');
    } finally { setBusy(null); }
  };

  const addSearchResult = async (result) => {
    const item = toQueueItem({
      title: result.title, artist: result.uploader || result.artist || '', image: artworkFor(result),
      folderName: safeFolder, mediaUrl: result.url, durationSec: result.durationSec,
    });
    if (await queueItems([item], null)) setQueued((prev) => new Set(prev).add(resultKey(result)));
  };

  const importLink = async (event) => {
    event.preventDefault();
    if (!link.trim() || busy) return;
    setBusy('Reading link…');
    setPreview(null);
    try {
      const out = await sources.resolve(link.trim(), { mode: 'auto', perTrackArtwork: true, onStatus: setBusy });
      if (out.error) { onToast(out.error, 'err'); return; }
      if (out.kind === 'profile') { onToast('Use the Spotify profile tab for profile links.', 'err'); return; }
      setPreview(out);
      history.remember({ kind: 'link', label: link.trim(), name: out.name, count: out.results.length,
                 image: out.group?.artworkUrl || '' });
    } catch (error) { onToast(error.message, 'err'); }
    finally { setBusy(null); }
  };

  // Rows that are themselves albums cannot be queued as tracks - they hold N of
  // them - so "Add all" takes the real tracks and says what it left behind.
  const queuePreview = async () => {
    const sets = preview.results.filter((r) => r.isSet);
    const tracks = preview.results.filter((r) => !r.isSet);
    if (!tracks.length) {
      onToast(`Open an album to add its tracks — ${sets.length} albums here, no loose tracks.`, 'err');
      return;
    }
    await queueItems(tracks.map((r) => toQueueItem({
      title: r.texts[0], artist: r.texts[1] || '', image: r.image,
      folderName: preview.group.folderName, group: preview.group, mediaUrl: r.mediaUrl, durationSec: r.durationSec,
    })), preview.name);
    if (sets.length) onToast(`${sets.length} album${sets.length > 1 ? 's were' : ' was'} skipped — open one to add its tracks.`);
  };

  const loadProfile = async (event) => {
    event.preventDefault();
    if (!profileName.trim() || busy) return;
    setBusy('Finding public playlists…');
    setProfile(null);
    try {
      const out = await sources.resolve(profileName.trim(), { mode: 'spotify-profile' });
      if (out.error || out.kind !== 'profile') { onToast(out.error || 'Enter a valid Spotify username.', 'err'); return; }
      // A pasted Deezer profile link reads as Deezer even from this tab, and its
      // API answers the same two questions the Spotify scrape does.
      const res = out.service === 'deezer'
        ? await sources.deezerProfilePlaylists(out.user)
        : await sources.spotifyProfilePlaylists(out.user, setBusy);
      if (res.error) { onToast(res.error, 'err'); return; }
      const info = res.profile || { service: out.service, user: out.user, name: out.user, image: '' };
      setProfile({ ...out, info, playlists: res.playlists });
      history.remember({ kind: 'profile', label: out.user, name: info.name || out.user, count: res.playlists.length,
                 image: info.image || (res.playlists.find((p) => p.image) || {}).image || '',
                 results: res.playlists, user: out.user, info });
    } catch (error) { onToast(error.message, 'err'); }
    finally { setBusy(null); }
  };

  // Reading one playlist of a profile. Deliberately WITHOUT per-track artwork:
  // that is one extra request per track, and a profile multiplies it by every
  // playlist it holds - the playlist cover is what ends up in cover.jpg anyway.
  const readPlaylist = (playlist, perTrackArtwork = false) => (
    playlist.service === 'deezer'
      ? sources.deezerPlaylist({ id: playlist.id, type: 'playlist', name: playlist.name, image: playlist.image })
      : sources.spotifyPlaylist(`https://open.spotify.com/playlist/${playlist.id}`, {
          playlistName: playlist.name, cover: playlist.image, perTrackArtwork,
        })
  );

  const profileMeta = (info) => ({
    id: `profile-${info.service || 'spotify'}-${info.user}`,
    name: info.name || info.user,
    user: info.user,
    service: info.service || 'spotify',
    image: info.image || '',
    folderName: sanitizeFolder(info.name || info.user),
    order,
  });

  /**
   * The whole profile, in one click.
   *
   * Every playlist is READ first and queued second, for two reasons. The track
   * counts a profile grid shows are a hint at best and missing at worst, so
   * "most tracks first" can only be honest once the playlists have actually been
   * read; and a run that queues as it goes would start downloading in the grid's
   * order and then contradict itself halfway through when the sort landed.
   */
  const downloadProfile = async () => {
    if (!profile || busy) return;
    const info = profile.info || { service: profile.service, user: profile.user, name: profile.user };
    const meta = profileMeta(info);
    const list = profile.playlists;
    let read = 0;
    setBusy(`Reading ${list.length} playlists…`);

    const failed = [];
    const resolved = await mapPool(list, 4, async (playlist) => {
      let out = null;
      try { out = await readPlaylist(playlist); }
      catch (e) { out = { error: e.message }; }
      read++;
      setBusy(`Reading playlists… ${read} of ${list.length}`);
      if (!out || out.error) { failed.push({ playlist, error: (out && out.error) || 'unreadable' }); return null; }
      return { playlist, out };
    });

    const usable = resolved.filter(Boolean);
    if (!usable.length) {
      onToast(`Could not read any of ${info.name || info.user}'s playlists.`, 'err');
      setBusy(null);
      return;
    }

    // Sorted on the counts that were just measured, not on the grid's guess.
    const ordered = sortPlaylists(
      usable.map((u) => ({ ...u.playlist, tracks: u.out.results.length, _read: u })),
      order,
    );

    setBusy(`Queueing ${ordered.length} playlists…`);
    let queued = 0;
    for (const row of ordered) {
      const { out } = row._read;
      const group = {
        ...out.group,
        // The group folder is the playlist's folder INSIDE the user's folder,
        // which is the whole point of downloading a profile rather than forty
        // playlists by hand.
        folderName: joinFolder(meta.folderName, out.group.folderName),
      };
      queued += await queueItems(out.results.map((r) => toQueueItem({
        title: r.texts[0], artist: r.texts[1] || '', image: r.image,
        folderName: group.folderName, group, profile: meta,
      })), null, true);
    }

    setBusy(null);
    const note = failed.length ? ` ${failed.length} playlist${failed.length === 1 ? '' : 's'} could not be read.` : '';
    onToast(queued
      ? `Queued ${queued} track${queued === 1 ? '' : 's'} from ${ordered.length} of ${info.name || info.user}'s playlists.${note}`
      : `Nothing new to download from ${info.name || info.user}.${note}`, queued ? undefined : 'err');
  };


  // One playlist off a profile grid. It still lands under the user's folder:
  // adding two of someone's playlists by hand and then downloading the profile
  // should not scatter the same music across two different places.
  const queuePlaylist = async (playlist) => {
    setBusy(`Reading “${playlist.name}”…`);
    try {
      const out = await readPlaylist(playlist, true);
      if (out.error) { onToast(out.error, 'err'); return; }
      const info = (profile && profile.info) || null;
      const meta = info ? profileMeta(info) : null;
      const group = meta
        ? { ...out.group, folderName: joinFolder(meta.folderName, out.group.folderName) }
        : out.group;
      if (playlist.service !== 'deezer') {
        history.remember({ kind: 'link', label: `https://open.spotify.com/playlist/${playlist.id}`,
                   name: out.name, count: out.results.length,
                   image: out.group?.artworkUrl || playlist.image || '' });
      }
      await queueItems(out.results.map((r) => toQueueItem({
        title: r.texts[0], artist: r.texts[1] || '', image: r.image,
        folderName: group.folderName, group, profile: meta,
      })), out.name);
    } catch (error) { onToast(error.message || 'Could not read that playlist.', 'err'); }
    finally { setBusy(null); }
  };


  // Re-opening costs nothing it does not have to: a search replays its stored
  // results, and a link goes back through the resolve cache.
  const openHistory = async (entry) => {
    if (entry.kind === 'profile') {
      setMode('profile');
      setProfileName(entry.user || entry.label);
      const info = entry.info || { service: 'spotify', user: entry.user || entry.label, name: entry.name || entry.label, image: entry.image || '' };
      setProfile({ user: entry.user || entry.label, service: info.service, info, playlists: entry.results || [] });
      return;
    }
    if (entry.kind === 'search') {
      setMode('search');
      setQuery(entry.label);
      setResults(entry.results || []);
      setQueued(new Set());
      setSearchState('done');
      return;
    }
    setMode('link');
    setLink(entry.label);
    setBusy('Reading link…');
    try {
      const out = await sources.resolve(entry.label, { mode: 'auto', perTrackArtwork: true, onStatus: setBusy });
      if (out.error) { onToast(out.error, 'err'); return; }
      setPreview(out);
    } catch (error) { onToast(error.message, 'err'); }
    finally { setBusy(null); }
  };

  const openSet = async (row) => {
    if (!row.mediaUrl) return;
    setSetModal({ title: row.title, image: row.image, loading: true });
    try {
      const out = await sources.resolve(row.mediaUrl, { mode: 'auto', perTrackArtwork: true });
      if (out.error) { setSetModal({ title: row.title, image: row.image, error: out.error }); return; }
      setSetModal({ title: row.title, image: row.image, preview: out });
      history.remember({ kind: 'link', label: row.mediaUrl, name: out.name, count: out.results.length,
                 image: out.group?.artworkUrl || row.image || '' });
    } catch (error) {
      setSetModal({ title: row.title, image: row.image, error: error.message || 'Could not read that album.' });
    }
  };

  // An album card can go straight to the queue: the resolve behind it is the
  // same cached one the pop-up uses, so this costs a request only the first time.
  const queueSet = async (row) => {
    if (!row.mediaUrl) return;
    setBusy(`Reading “${row.title}”…`);
    try {
      const out = await sources.resolve(row.mediaUrl, { mode: 'auto', perTrackArtwork: true, onStatus: setBusy });
      if (out.error) { onToast(out.error, 'err'); return; }
      history.remember({ kind: 'link', label: row.mediaUrl, name: out.name, count: out.results.length,
                 image: out.group?.artworkUrl || row.image || '' });
      await queueItems(out.results.map((r) => toQueueItem({
        title: r.texts[0], artist: r.texts[1] || '', image: r.image,
        folderName: out.group.folderName, group: out.group,
        mediaUrl: r.mediaUrl, durationSec: r.durationSec,
      })), out.name);
    } catch (error) { onToast(error.message || 'Could not read that album.', 'err'); }
    finally { setBusy(null); }
  };

  const setModalItem = (r) => toQueueItem({
    title: r.texts[0], artist: r.texts[1] || '', image: r.image,
    folderName: setModal.preview.group.folderName, group: setModal.preview.group,
    mediaUrl: r.mediaUrl, durationSec: r.durationSec,
  });

  const previewTracks = useMemo(() => preview?.results?.map((r) => ({
    title: r.texts[0], artist: r.texts[1] || '', image: r.image, durationSec: r.durationSec,
    mediaUrl: r.mediaUrl, isSet: r.isSet,
  })) || [], [preview]);

  return (
    <>
      <header className="topbar add-topbar">
        <div><h1>Add music</h1><span className="topbar-subtitle">Find the right recording before it enters your queue</span></div>
        {busy && <><span className="spacer" /><span className="pill accent live"><span className="dot" />{busy}</span></>}
      </header>

      <div className="pane add-pane">
        <div className="add-hero">
          <div className="mode-tabs" role="tablist" aria-label="Add music method">
            {MODES.map((item) => <button key={item.id} role="tab" aria-selected={mode === item.id}
              className="mode-tab" onClick={() => { setMode(item.id); setBusy(null); }}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}
          </div>

          {mode === 'search' && <form className="discovery-form" onSubmit={search}>
            <label htmlFor="track-search">Search by track, artist, or both</label>
            <div className="search-control"><span className="search-icon" aria-hidden="true">⌕</span>
              <input id="track-search" className="input" autoFocus placeholder="Try “Mr.Kitty — After Dark”" value={query} onChange={(e) => setQuery(e.target.value)} />
              {query && <button type="button" className="clear-input" aria-label="Clear search" onClick={() => { setQuery(''); setResults([]); setSearchState('idle'); }}>×</button>}
              <button className="btn btn-primary search-button" disabled={!query.trim() || !!busy}>{searchState === 'loading' ? 'Searching…' : 'Search'}</button>
            </div>
            <div className="form-foot"><span>Results from YouTube and SoundCloud</span><label className="folder-inline">Save to folder<input className="input" placeholder="Optional" value={folder} onChange={(e) => setFolder(e.target.value)} /></label></div>
          </form>}

          {mode === 'link' && <form className="discovery-form" onSubmit={importLink}>
            <label htmlFor="music-link">Playlist, album, or track link</label>
            <div className="search-control"><span className="search-icon" aria-hidden="true">↗</span>
              <input id="music-link" className="input" autoFocus placeholder="Paste a Spotify, Deezer, SoundCloud, YouTube, or Lucida link" value={link} onChange={(e) => { setLink(e.target.value); setPreview(null); }} />
              <button className="btn btn-primary search-button" disabled={!link.trim() || !!busy}>Preview</button>
            </div><div className="form-foot"><span>Nothing is queued until you review the tracks.</span></div>
          </form>}

          {mode === 'profile' && <form className="discovery-form" onSubmit={loadProfile}>
            <label htmlFor="profile-search">Spotify username or profile link</label>
            <div className="search-control"><span className="search-icon" aria-hidden="true">◎</span>
              <input id="profile-search" className="input" autoFocus placeholder="thesimulacrum" value={profileName} onChange={(e) => { setProfileName(e.target.value); setProfile(null); }} />
              <button className="btn btn-primary search-button" disabled={!profileName.trim() || !!busy}>Show playlists</button>
            </div><div className="form-foot"><span>Only public playlists can be shown.</span></div>
          </form>}
        </div>

        {mode === 'search' && searchState === 'idle' && <div className="discovery-empty"><div className="empty-orbit"><span>♪</span></div><h2>Search first. Queue second.</h2><p>Compare the title, uploader, artwork, source, and duration—then choose the exact recording you want.</p></div>}

        {mode === 'search' && searchState === 'loading' && <section className="results-section" aria-busy="true"><div className="results-heading"><div><span className="eyebrow">Searching</span><h2>Finding matching recordings…</h2></div></div><div className="media-grid skeleton-grid">{Array.from({ length: 8 }, (_, i) => <div className="media-card skeleton" key={i} />)}</div></section>}

        {mode === 'search' && searchState === 'done' && <section className="results-section">
          <div className="results-heading"><div><span className="eyebrow">Search results</span><h2>{results.length ? `${results.length} recordings for “${query.trim()}”` : 'No recordings found'}</h2></div>{!!results.length && <span className="result-note">Review before adding</span>}</div>
          {results.length ? <div className="media-grid">{results.map((result) => <TrackCard key={resultKey(result)} result={result} queued={queued.has(resultKey(result))} disabled={!!busy} action={() => addSearchResult(result)} />)}</div>
            : <div className="inline-empty"><strong>No matches yet</strong><span>Try fewer words, check the spelling, or search by artist and title.</span></div>}
        </section>}

        {mode === 'link' && preview && !preview.error && <section className="results-section">
          <div className="results-heading playlist-heading"><div className="playlist-identity">{preview.group.artworkUrl ? <img src={preview.group.artworkUrl} alt="" /> : <EmptyArtwork kind="playlist" />}<div><span className="eyebrow">Ready to review</span><h2>{preview.name}</h2><p>{preview.results.length} tracks · {preview.group.folderName}</p></div></div><button className="btn btn-primary" onClick={queuePreview} disabled={!!busy}>＋ Add all {preview.results.filter((r) => !r.isSet).length || preview.results.length}</button></div>
          <div className="media-grid">{previewTracks.map((result, i) => <TrackCard key={`${result.title}-${i}`} result={result} actionLabel="Add track" disabled={!!busy} onOpen={() => openSet(result)} action={() => (result.isSet ? queueSet(result) : queueItems([toQueueItem({ ...result, folderName: preview.group.folderName, group: preview.group })], preview.name))} />)}</div>
        </section>}

        {mode === 'profile' && profile && <section className="results-section">
          <div className="results-heading profile-heading">
            <div className="profile-identity">
              {profile.info?.image
                ? <img className="profile-avatar" src={profile.info.image} alt="" referrerPolicy="no-referrer" />
                : <div className="profile-avatar placeholder" aria-hidden="true">{(profile.info?.name || profile.user || '?').slice(0, 1).toUpperCase()}</div>}
              <div>
                <span className="eyebrow">{profile.info?.service === 'deezer' ? 'Deezer profile' : 'Spotify profile'}</span>
                <h2>{profile.info?.name || profile.user}</h2>
                <p>{profile.playlists.length} public {profile.playlists.length === 1 ? 'playlist' : 'playlists'}
                  {profile.info?.name && profile.info.name !== profile.user ? ` · ${profile.user}` : ''}</p>
              </div>
            </div>
            <div className="profile-actions">
              <label className="order-inline">Download order
                <select className="input" value={order} onChange={(e) => setOrder(e.target.value)} disabled={!!busy}>
                  {PROFILE_ORDERS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </label>
              <button className="btn btn-primary" onClick={downloadProfile} disabled={!!busy || !profile.playlists.length}>
                ⬇ Download whole profile
              </button>
            </div>
          </div>
          {/* Said out loud because it is the one thing about this button that is
              not obvious: every playlist lands in one folder named after the
              user, and the run ends with a report of what it could not find. */}
          <p className="profile-note">
            Everything goes to <strong>{sanitizeFolder((profile.info?.name) || profile.user)}/</strong>, one folder per playlist,
            with a report of what was downloaded and what was missed.
          </p>
          <div className="playlist-grid">{sortPlaylists(profile.playlists, order).map((playlist) => (
            <article className="playlist-card" key={playlist.id}>
              <div className="playlist-cover">{playlist.image ? <img src={playlist.image} alt="" loading="lazy" /> : <EmptyArtwork kind="playlist" />}</div>
              <div className="playlist-copy">
                <h3 title={playlist.name}>{playlist.name}</h3>
                <p>{playlist.tracks > 0 ? `${playlist.tracks} tracks` : (playlist.service === 'deezer' ? 'Deezer playlist' : 'Spotify playlist')}</p>
              </div>
              <button className="btn card-action" onClick={() => queuePlaylist(playlist)} disabled={!!busy}>＋ Add playlist</button>
            </article>))}
          </div>
        </section>}
        {mode === 'history' && (entries.length ? <section className="results-section">
          <div className="results-heading">
            <div><span className="eyebrow">History</span><h2>{entries.length} past {entries.length === 1 ? 'lookup' : 'lookups'}</h2></div>
            <button className="btn subtle" onClick={() => history.clearHistory()}>Clear history</button>
          </div>
          {groupByDay(entries).map((group) => <div className="history-group" key={group.label}>
            <h3 className="history-day">{group.label}</h3>
            {group.entries.map((entry) => <HistoryEntry key={entry.id} entry={entry} busy={busy}
              onOpen={() => openHistory(entry)} onForget={() => history.forget(entry.id)} />)}
          </div>)}
        </section> : <div className="discovery-empty"><div className="empty-orbit"><span>⟲</span></div><h2>Nothing searched yet</h2><p>Searches and pasted links are kept here, newest first, so you can open one again without typing it out.</p></div>)}
      </div>

      {setModal && <SetModal state={setModal} busy={busy} onClose={() => setSetModal(null)}
        onQueueAll={() => queueItems(setModal.preview.results.map(setModalItem), setModal.preview.name)}
        onQueueOne={(r) => queueItems([setModalItem(r)], setModal.preview.name)} />}
    </>
  );
}
