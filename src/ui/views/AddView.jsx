import { useMemo, useState, useSyncExternalStore } from 'react';
import { getController, isElectron, ipc, sources } from '../engine.js';
import * as history from '../history.js';
import { buildSearchVariants, buildSearchQuery } from '../../engine/variants.mjs';
import { sanitizeFolder, joinFolder, sortPlaylists, PROFILE_ORDERS, mapPool } from '../../engine/sources.mjs';
import { trackKey } from '../../engine/trackKey.mjs';
import { assignPlaylistFiles } from '../../engine/profile-paths.mjs';
import { refreshSpotifyArtwork } from '../../engine/spotify-artwork.mjs';
import Icon from '../components/Icon.jsx';

let seq = 0;
// Searching and pasting a link used to be two tabs with two inputs, and the
// user had to pick the right one before typing. They are one box now: what is
// typed decides what happens (see looksLikeLink). Profiles stay separate - a
// bare username is indistinguishable from a search for an artist.
const MODES = [
  { id: 'search', label: 'Search or paste a link', icon: 'search' },
  { id: 'profile', label: 'Spotify profile', icon: 'user' },
  { id: 'history', label: 'History', icon: 'history' },
];
const SEARCH_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'tracks', label: 'Songs' },
  { id: 'albums', label: 'Albums' },
  { id: 'artists', label: 'Artists' },
];
const DEMO_RESULTS = [
  { id: 'demo-artist-1', artistId: '27', name: 'Daft Punk', title: 'Daft Punk', isArtist: true, albumCount: 14, fanCount: 4820000, image: 'https://e-cdns-images.dzcdn.net/images/artist/f2bc007e9133c946ac3c3907ddc5d2ea/500x500-000000-80-0-0.jpg' },
  { id: 'demo-2', title: 'Random Access Memories', artist: 'Daft Punk', artistId: '27', isSet: true, deezerAlbumId: '6575789', trackCount: 13, source: 'flac', image: 'https://e-cdns-images.dzcdn.net/images/cover/311bba0fc112d15f72c8b5a65f0456c1/500x500-000000-80-0-0.jpg' },
  { id: 'demo-1', title: 'After Dark', artist: 'Mr.Kitty', artistId: '412', album: 'Time', albumId: '90123', durationSec: 259, source: 'flac', image: 'https://e-cdns-images.dzcdn.net/images/cover/b41a5fc5372ae6014e7a4627d758c5be/500x500-000000-80-0-0.jpg' },
  { id: 'demo-3', title: 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', artist: 'Daft Punk', artistId: '27', album: 'Random Access Memories', albumId: '6575789', durationSec: 369, source: 'flac', image: 'https://e-cdns-images.dzcdn.net/images/cover/311bba0fc112d15f72c8b5a65f0456c1/500x500-000000-80-0-0.jpg' },
  { id: 'demo-4', title: 'Instant Crush (feat. Julian Casablancas)', artist: 'Daft Punk', artistId: '27', album: 'Random Access Memories', albumId: '6575789', durationSec: 337, source: 'flac', image: 'https://e-cdns-images.dzcdn.net/images/cover/311bba0fc112d15f72c8b5a65f0456c1/500x500-000000-80-0-0.jpg' },
];

// What counts as "a link" in the unified box: any http(s) URL, a spotify: URI,
// or a share host typed without its scheme. Anything else is a search. A URL to
// an unsupported site still goes down the link path, so the user is told it is
// unsupported instead of getting search results for the text of a URL.
const LINK_RE = /^(?:https?:\/\/|spotify:)|^(?:open\.spotify\.com|spotify\.link|(?:www\.)?deezer\.com|deezer\.page\.link|link\.deezer\.com)\//i;
function looksLikeLink(text) {
  return LINK_RE.test(String(text || '').trim());
}

function toQueueItem({ title, artist, album, image, folderName, group, mediaUrl, durationSec, profile, service, originalService, trackId, isrc, artworkPending }) {
  return {
    id: `add-${Date.now()}-${seq++}`,
    title, artist,
    // Carried so buildSearchVariants can build its disambiguate-by-album
    // wording. Without it that variant collapsed into the lead-artist one and
    // was dropped by the dedup filter, so one of the six documented search
    // strategies had never once run.
    album: album || null,
    name: `${artist || 'Unknown artist'} - ${title}`,
    image: image || null,
    service: service || null,
    trackId: trackId || null,
    isrc: isrc || null,
    artworkPending: !!artworkPending,
    folderName: folderName || null,
    mediaUrl: mediaUrl || null,
    mediaService: null,
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
    originalService: originalService || service || (profile && profile.service) || (group && group.service) || 'deezer',
    searchQuery: buildSearchQuery(title, artist),
    searchVariants: buildSearchVariants(title, artist, album || ''),
    key: `${folderName || ''}|${title}|${artist}`.toLowerCase(),
  };
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

function artworkFor(result) {
  return result.thumbnail || result.image || null;
}

function previewError(out) {
  if (out?.error) return out.error;
  if (out?.kind === 'profile') return 'Use the Spotify profile tab for profile links.';
  if (!out?.group || !Array.isArray(out.results) || !out.results.length) {
    return 'Paste a Spotify, Deezer, Tidal, or Qobuz playlist, album, or track link.';
  }
  return null;
}

async function withoutExisting(items) {
  if (!isElectron || !items.length) return { items, skipped: 0, guessed: 0 };
  // Covers must also be restored when every audio file is already on disk.
  const artwork = new Map();
  for (const item of items) {
    if (item.folderName && item.groupArtwork) artwork.set(item.folderName, item.groupArtwork);
  }
  for (const [folderName, url] of artwork) ipc.send('playlist-artwork-sync', { folderName, url });
  try {
    const checks = await ipc.invoke('downloads-check', items.map((i) => ({ key: i.key, folderName: i.folderName, title: i.title, artist: i.artist, durationSec: i.durationSec, isrc: i.isrc })));
    return {
      items: items.filter((_, i) => !(checks[i] && checks[i].done)),
      skipped: checks.filter((r) => r && r.done).length,
      // A manifest hit is a fact - the app recorded that exact file. A SCAN hit
      // is a guess from title tokens alone, with no artist check, so "Dark
      // Essence (Remix).flac" satisfies a want of "Dark Essence". Both used to
      // arrive as an identical `done: true` and the track just silently never
      // appeared, which is the wrong way round: the guess is the one worth
      // saying out loud.
      guessed: checks.filter((r) => r && r.done && r.via === 'scan').length,
    };
  } catch { return { items, skipped: 0, guessed: 0 }; }
}

function EmptyArtwork({ kind = 'track' }) {
  return (
    <div className="media-placeholder" aria-hidden="true">
      <Icon name={kind === 'playlist' ? 'disc' : kind === 'artist' ? 'user' : 'music'} size={24} />
    </div>
  );
}

function ArtistCard({ artist, onOpen, disabled }) {
  const art = artworkFor(artist);
  return (
    <button type="button" className="artist-card" onClick={() => onOpen(artist)} disabled={disabled}>
      <div className="artist-card-avatar">
        {art ? <img src={art} alt="" loading="lazy" /> : <EmptyArtwork kind="artist" />}
      </div>
      <div className="artist-card-info">
        <h3 title={artist.name || artist.title}>{artist.name || artist.title}</h3>
        <p>Artist{artist.albumCount ? ` · ${artist.albumCount} albums` : ''}</p>
      </div>
    </button>
  );
}

/** Album / set card. Songs are rendered by SongList instead. */
function AlbumCard({ result, action, onDownloadNow, queued = false, disabled = false, onOpen, onArtistClick }) {
  const art = artworkFor(result);
  const artistName = result.artist || result.uploader || 'Unknown artist';
  const kind = result.recordType && result.recordType !== 'album' ? result.recordType.toUpperCase() : null;

  return (
    <article className="media-card">
      <div className="media-cover" onClick={onOpen} style={onOpen ? { cursor: 'pointer' } : undefined}>
        {art ? <img src={art} alt="" loading="lazy" /> : <EmptyArtwork kind="playlist" />}
        {(kind || result.trackCount) && (
          <span className="set-badge">
            {kind ? `${kind} · ` : ''}{result.trackCount ? `${result.trackCount} tracks` : 'Album'}
          </span>
        )}
        {queued && <span className="queued-badge"><Icon name="check" size={11} />Queued</span>}
        <div className="cover-hover-actions" onClick={(e) => e.stopPropagation()}>
          {onDownloadNow && (
            <button type="button" className="hover-btn priority" onClick={onDownloadNow} disabled={disabled} title="Download now (jump the queue)" aria-label="Download now">
              <Icon name="zap" size={15} />
            </button>
          )}
          <button type="button" className="hover-btn primary" onClick={action} disabled={disabled} title="Add every track to the queue" aria-label="Queue album">
            <Icon name="plus" size={18} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      <div className="media-details">
        <h3 title={result.title} className={onOpen ? 'clickable' : undefined} onClick={onOpen}>{result.title}</h3>
        <p className="media-sub">
          {onArtistClick && (result.artistId || result.artist) ? (
            <button type="button" className="meta-link" onClick={() => onArtistClick({ id: result.artistId, name: artistName })} title={`View artist ${artistName}`}>
              {artistName}
            </button>
          ) : (
            <span title={artistName}>{artistName}</span>
          )}
          {result.releaseDate ? ` · ${result.releaseDate.slice(0, 4)}` : ''}
        </p>
      </div>
    </article>
  );
}

/**
 * A list of songs: search results, link previews, an artist's top tracks.
 *
 * These used to be a grid of album-cover cards, which for songs is the wrong
 * shape: twelve hits from one album were twelve identical covers, and the thing
 * that actually tells songs apart - title, artist, album, length - was squeezed
 * under each image. A list puts that information in columns you can scan.
 */
function SongList({ rows, isQueued, onQueue, onNow, onArtistClick, onAlbumClick, disabled, showArt = true }) {
  return (
    <div className="song-list" role="list">
      {rows.map((r, i) => {
        const queued = isQueued ? isQueued(r) : false;
        const artistName = r.artist || r.uploader || '';
        const art = artworkFor(r);
        return (
          <div className={`song-row${queued ? ' is-queued' : ''}`} role="listitem" key={r.key || `${r.id || r.title}-${i}`}
            style={showArt ? undefined : { gridTemplateColumns: '28px minmax(0, 2fr) minmax(0, 1.2fr) 48px 84px' }}>
            <span className="song-num">{i + 1}</span>
            {showArt && (art
              ? <img className="song-art" src={art} alt="" loading="lazy" />
              : <div className="song-art" aria-hidden="true"><Icon name="music" size={14} /></div>)}
            <div className="song-main">
              <div className="song-title" title={r.title}>{r.title}</div>
              <div className="song-artist">
                {onArtistClick && artistName ? (
                  <button type="button" className="meta-link" onClick={() => onArtistClick({ id: r.artistId, name: artistName })}>{artistName}</button>
                ) : artistName}
              </div>
            </div>
            <div className="song-album">
              {r.album && (onAlbumClick && r.albumId ? (
                <button type="button" className="meta-link" title={`Open album ${r.album}`}
                  onClick={() => onAlbumClick({ id: r.albumId, deezerAlbumId: r.albumId, title: r.album, artist: artistName, image: art, isSet: true })}>
                  {r.album}
                </button>
              ) : <span title={r.album}>{r.album}</span>)}
            </div>
            <span className="song-dur">{formatDuration(r.durationSec) || ''}</span>
            <div className="song-actions">
              {queued ? (
                <span className="song-queued"><Icon name="check" size={13} />Queued</span>
              ) : (
                <>
                  {onNow && (
                    <button type="button" className="icon-btn priority" onClick={() => onNow(r)} disabled={disabled} title="Download now (jump the queue)" aria-label={`Download ${r.title} now`}>
                      <Icon name="zap" size={13} />
                    </button>
                  )}
                  <button type="button" className="icon-btn" onClick={() => onQueue(r)} disabled={disabled} title="Add to queue" aria-label={`Queue ${r.title}`}>
                    <Icon name="plus" size={16} />
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SkeletonGrid({ n = 6 }) {
  return <div className="media-grid">{Array.from({ length: n }, (_, i) => <div className="skeleton" key={i} />)}</div>;
}

/** A set inside a set - a /albums link lists albums, not tracks - opened in
 *  place so the user can see what is in one before queueing any of it. */
function SetModal({ state, onClose, onQueueAll, onDownloadAllNow, onQueueOne, onDownloadOneNow, onOpenArtist, busy }) {
  const rows = state.preview?.results || [];
  const artistName = state.artist || rows[0]?.texts?.[1] || '';
  const songs = rows.map((r, i) => ({ ...r, key: `${r.texts[0]}-${i}`, title: r.texts[0], artist: r.texts[1] || artistName }));
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={state.title} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div className="playlist-identity">
            {state.preview?.group?.artworkUrl || state.image
              ? <img src={state.preview?.group?.artworkUrl || state.image} alt="" />
              : <EmptyArtwork kind="playlist" />}
            <div style={{ minWidth: 0 }}>
              <span className="eyebrow">{state.loading ? 'Reading…' : 'Album'}</span>
              <h2 className="truncate">{state.preview?.name || state.title}</h2>
              {!state.loading && !state.error && (
                <p>
                  {artistName && (
                    onOpenArtist ? (
                      <button type="button" className="meta-link" onClick={() => { onClose(); onOpenArtist({ name: artistName }); }}>
                        {artistName}
                      </button>
                    ) : artistName
                  )}
                  {artistName ? ' · ' : ''}{rows.length} tracks
                </p>
              )}
            </div>
          </div>
          <div className="modal-actions">
            {!state.loading && !state.error && !!rows.length && (
              <>
                {onDownloadAllNow && (
                  <button className="btn btn-icon" onClick={onDownloadAllNow} disabled={!!busy} title="Download album now" aria-label="Download album now">
                    <Icon name="zap" size={15} />
                  </button>
                )}
                <button className="btn btn-primary" onClick={onQueueAll} disabled={!!busy}>
                  <Icon name="plus" size={15} />Queue {rows.length}
                </button>
              </>
            )}
            <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
          </div>
        </header>
        <div className="modal-body">
          {state.loading && <SkeletonGrid n={4} />}
          {state.error && <div className="inline-empty"><strong>Could not open that album</strong><span>{state.error}</span></div>}
          {!state.loading && !state.error && (
            <SongList
              rows={songs}
              showArt={false}
              disabled={!!busy}
              onQueue={onQueueOne}
              onNow={onDownloadOneNow}
            />
          )}
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

const HISTORY_KIND = {
  search: { icon: 'search', label: 'Search' },
  link: { icon: 'link', label: 'Link' },
  profile: { icon: 'user', label: 'Profile' },
};

function HistoryEntry({ entry, onOpen, onForget, busy }) {
  const kind = HISTORY_KIND[entry.kind] || HISTORY_KIND.link;
  return (
    <article className="history-row">
      <div className="history-art">
        {entry.image ? <img src={entry.image} alt="" loading="lazy" /> : <EmptyArtwork kind={entry.kind === 'link' ? 'playlist' : entry.kind === 'profile' ? 'artist' : 'track'} />}
      </div>
      <div className="history-copy">
        <h3 title={entry.name || entry.label}>{entry.name || entry.label}</h3>
        <p>
          <span className="history-kind"><Icon name={kind.icon} size={12} />{kind.label}</span>
          {entry.count ? ` · ${entry.count} ${entry.kind === 'profile'
            ? (entry.count === 1 ? 'playlist' : 'playlists')
            : (entry.count === 1 ? 'result' : 'results')}` : ''}
          {entry.kind === 'link' ? ` · ${entry.label.replace(/^https?:\/\//, '').slice(0, 60)}` : ''}
        </p>
      </div>
      <div className="history-actions">
        <button className="btn btn-sm" onClick={onOpen} disabled={!!busy}>Open</button>
        <button className="icon-btn danger" onClick={onForget} aria-label="Remove from history" title="Remove from history">
          <Icon name="x" size={14} />
        </button>
      </div>
    </article>
  );
}

export default function AddView({ onToast }) {
  const [mode, setMode] = useState('search');
  const [searchFilter, setSearchFilter] = useState('all'); // 'all' | 'tracks' | 'albums' | 'artists'
  const [query, setQuery] = useState('');
  const [profileName, setProfileName] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(null);
  const [results, setResults] = useState([]);
  const [searchState, setSearchState] = useState('idle');
  const [artistView, setArtistView] = useState(null); // { id, name, image, fanCount, albumCount, albums, topTracks, loading, error }
  const [preview, setPreview] = useState(null);
  const [profile, setProfile] = useState(null);
  const [order, setOrder] = useState('default');
  const [queued, setQueued] = useState(new Set());
  const [setModal, setSetModal] = useState(null);
  useSyncExternalStore(history.subscribe, history.getSnapshot);
  const entries = history.list();
  const recentProfiles = entries.filter(entry => entry.kind === 'profile');

  // Derived, not state: whether the box holds a link is a pure function of what
  // is in it, so storing it separately could only ever drift out of step.
  const isLink = looksLikeLink(query);

  const resultKey = (r) => (r.isArtist ? 'artist:' : r.isSet ? 'album:' : 'track:') + (r.id || r.url || `${r.title}|${r.artist || r.uploader}`);
  const safeFolder = folder.trim() ? sanitizeFolder(folder.trim()) : null;

  const queueItems = async (items, label, quiet = false, explicitOpts = {}) => {
    const { items: keep, skipped, guessed } = await withoutExisting(items);
    const controller = getController();
    const n = controller.add(keep, explicitOpts);
    const dupes = (controller.lastAdd && controller.lastAdd.duplicates) || 0;
    // Worth saying out loud: a playlist that lists a track twice looks like the
    // app lost tracks unless the collapse is reported.
    const dupeNote = dupes ? ` ${dupes} duplicate${dupes === 1 ? '' : 's'} collapsed.` : '';
    // A scan match is a guess, so it is named as one - otherwise a track the
    // folder scan mistook for another simply never appears and nothing says why.
    const guessNote = guessed
      ? ` ${guessed} matched a similarly named file already in the folder.`
      : '';
    if (quiet) return n;
    const verb = explicitOpts.priority ? 'Prioritized' : 'Added';
    const dest = explicitOpts.priority ? 'at the top of the queue' : 'to the queue';
    if (n === 1) {
      const item = keep[0];
      onToast(`${verb} “${item.title}”${item.artist ? ` by ${item.artist}` : ''} ${dest}.${dupeNote}${guessNote}`);
    } else if (n > 1) {
      onToast(`${verb} ${n} tracks${label ? ` from ${label}` : ''} ${dest}.${dupeNote}${guessNote}`);
    }
    else if (dupes) onToast(`Already queued.${dupeNote}`);
    else if (skipped) onToast(`${skipped === 1 ? 'That track is' : 'Those tracks are'} already downloaded.${guessNote}`);
    else onToast('Nothing new was added.');
    return n;
  };

  const clearFinder = () => {
    setQuery(''); setResults([]); setSearchState('idle'); setArtistView(null); setPreview(null);
  };

  // One submit, two paths. The box decides which from what was typed.
  const submit = (event) => {
    event.preventDefault();
    const q = query.trim();
    if (!q || busy) return;
    if (looksLikeLink(q)) importLink(q);
    else search(q);
  };

  const search = async (q) => {
    setBusy('Searching tracks, albums, and artists…');
    setSearchState('loading');
    setArtistView(null);
    setPreview(null);
    setResults([]);
    setQueued(new Set());
    try {
      if (!isElectron) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        setResults(DEMO_RESULTS);
        setSearchState('done');
        return;
      }
      const [tracksRes, albumsRes, artistsRes] = await Promise.all([
        ipc.invoke('http-json', `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=24`).catch(() => null),
        ipc.invoke('http-json', `https://api.deezer.com/search/album?q=${encodeURIComponent(q)}&limit=18`).catch(() => null),
        ipc.invoke('http-json', `https://api.deezer.com/search/artist?q=${encodeURIComponent(q)}&limit=12`).catch(() => null),
      ]);

      const artists = ((artistsRes && artistsRes.data) || []).map((ar) => ({
        id: String(ar.id),
        artistId: String(ar.id),
        name: ar.name,
        title: ar.name,
        image: ar.picture_xl || ar.picture_big || ar.picture_medium || ar.picture || '',
        albumCount: ar.nb_album || 0,
        fanCount: ar.nb_fan || 0,
        isArtist: true,
      }));

      const albums = ((albumsRes && albumsRes.data) || []).map((a) => ({
        id: String(a.id),
        deezerAlbumId: String(a.id),
        title: a.title,
        artist: a.artist?.name || '',
        artistId: a.artist?.id ? String(a.artist.id) : null,
        image: a.cover_xl || a.cover_big || a.cover_medium || a.cover || '',
        isSet: true,
        recordType: a.record_type || 'album',
        trackCount: a.nb_tracks || 0,
        source: 'flac',
      }));

      const tracks = ((tracksRes && tracksRes.data) || []).map((t) => ({
        id: String(t.id),
        service: 'deezer',
        trackId: String(t.id),
        isrc: t.isrc,
        title: t.title,
        artist: t.artist?.name || '',
        artistId: t.artist?.id ? String(t.artist.id) : null,
        album: t.album?.title || '',
        albumId: t.album?.id ? String(t.album.id) : null,
        image: t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium || t.album?.cover || '',
        durationSec: t.duration || null,
        isSet: false,
        source: 'flac',
      }));

      const combined = [...artists, ...albums, ...tracks];
      setResults(combined);
      setSearchState('done');
      if (combined.length) {
        history.remember({
          kind: 'search', label: q, name: q, count: combined.length,
          image: (tracks[0] || albums[0] || artists[0])?.image || '', results: combined, folder: safeFolder
        });
      }
      if (!combined.length && (!tracksRes && !albumsRes && !artistsRes)) {
        onToast('Search provider is unavailable right now. Try again in a moment.', 'err');
      }
    } catch (error) {
      setSearchState('error');
      onToast(error.message || 'Search failed.', 'err');
    } finally { setBusy(null); }
  };

  const openArtist = async (target) => {
    if (!target || busy) return;
    setArtistView({
      id: target.id || target.artistId || null,
      name: target.name || target.title || 'Artist',
      image: target.image || '',
      loading: true,
      albums: [],
      topTracks: [],
    });
    try {
      if (!isElectron) {
        await new Promise((r) => setTimeout(r, 200));
        setArtistView({
          id: '27',
          name: target.name || 'Daft Punk',
          image: DEMO_RESULTS[0].image,
          albumCount: 14,
          loading: false,
          albums: DEMO_RESULTS.filter((r) => r.isSet),
          topTracks: DEMO_RESULTS.filter((r) => !r.isSet && !r.isArtist),
        });
        return;
      }
      const initialId = target.id || target.artistId;
      let artistMeta = null;
      if (!initialId && target.name) {
        const searchRes = await ipc.invoke('http-json', `https://api.deezer.com/search/artist?q=${encodeURIComponent(target.name)}&limit=5`);
        const match = (searchRes?.data || []).find((a) => a.name.toLowerCase() === target.name.toLowerCase()) || searchRes?.data?.[0];
        if (match) {
          artistMeta = match;
        }
      }
      const artistId = initialId || (artistMeta ? String(artistMeta.id) : null);
      if (!artistId) {
        setArtistView((prev) => ({ ...prev, loading: false, error: 'Could not find artist discography.' }));
        return;
      }

      const [infoRes, albumsRes, topRes] = await Promise.all([
        artistMeta ? Promise.resolve(artistMeta) : ipc.invoke('http-json', `https://api.deezer.com/artist/${artistId}`).catch(() => null),
        ipc.invoke('http-json', `https://api.deezer.com/artist/${artistId}/albums?limit=50`).catch(() => null),
        ipc.invoke('http-json', `https://api.deezer.com/artist/${artistId}/top?limit=15`).catch(() => null),
      ]);

      const artistName = infoRes?.name || target.name || 'Artist';
      const artistImage = infoRes?.picture_xl || infoRes?.picture_big || infoRes?.picture_medium || target.image || '';

      const albums = ((albumsRes && albumsRes.data) || []).map((a) => ({
        id: String(a.id),
        deezerAlbumId: String(a.id),
        title: a.title,
        artist: artistName,
        artistId: String(artistId),
        image: a.cover_xl || a.cover_big || a.cover_medium || a.cover || '',
        isSet: true,
        recordType: a.record_type || 'album',
        trackCount: a.nb_tracks || 0,
        releaseDate: a.release_date || '',
        source: 'flac',
      }));

      const topTracks = ((topRes && topRes.data) || []).map((t) => ({
        id: String(t.id),
        service: 'deezer',
        trackId: String(t.id),
        isrc: t.isrc,
        title: t.title,
        artist: t.artist?.name || artistName,
        artistId: String(artistId),
        album: t.album?.title || '',
        albumId: t.album?.id ? String(t.album.id) : null,
        image: t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium || t.album?.cover || artistImage,
        durationSec: t.duration || null,
        isSet: false,
        source: 'flac',
      }));

      setArtistView({
        id: String(artistId),
        name: artistName,
        image: artistImage,
        albumCount: infoRes?.nb_album || albums.length,
        fanCount: infoRes?.nb_fan || 0,
        loading: false,
        albums,
        topTracks,
      });
    } catch (error) {
      setArtistView((prev) => ({ ...prev, loading: false, error: error.message || 'Could not load artist.' }));
    }
  };

  const addSearchResult = async (result, explicitOpts = {}) => {
    if (result.isSet) {
      await queueSet(result, explicitOpts);
      setQueued((prev) => new Set(prev).add(resultKey(result)));
      return;
    }
    const item = toQueueItem({
      ...result,
      title: result.title,
      artist: result.artist || result.uploader || '',
      album: result.album,
      image: artworkFor(result),
      folderName: safeFolder,
      durationSec: result.durationSec,
    });
    if (await queueItems([item], null, false, explicitOpts)) setQueued((prev) => new Set(prev).add(resultKey(result)));
  };

  const importLink = async (url) => {
    setBusy('Reading link…');
    setPreview(null);
    setResults([]);
    setSearchState('idle');
    setArtistView(null);
    try {
      const out = await sources.resolve(url, { mode: 'auto', perTrackArtwork: true, onStatus: setBusy });
      // A profile link pasted into the main box is still an unambiguous request:
      // take the user to the profile view with it filled in rather than telling
      // them which tab they should have used.
      if (out?.kind === 'profile') {
        setBusy(null);
        setMode('profile');
        setProfileName(url);
        await loadProfileFor(url);
        return;
      }
      const error = previewError(out);
      if (error) { onToast(error, 'err'); return; }
      setPreview(out);
      if (out.warning) onToast(out.warning, 'err');
      setQueued(new Set());
      history.remember({ kind: 'link', label: url, name: out.name, count: out.results.length,
                 image: out.group?.artworkUrl || '' });
    } catch (error) { onToast(error.message, 'err'); }
    finally { setBusy(null); }
  };

  // Rows that are themselves albums cannot be queued as tracks - they hold N of
  // them - so "Add all" takes the real tracks and says what it left behind.
  const queuePreview = async (explicitOpts = {}) => {
    const sets = preview.results.filter((r) => r.isSet);
    const tracks = preview.results.filter((r) => !r.isSet);
    if (!tracks.length) {
      onToast(`Open an album to add its tracks — ${sets.length} albums here, no loose tracks.`, 'err');
      return;
    }
    const n = await queueItems(tracks.map((r) => toQueueItem({
      ...r,
      title: r.texts[0], artist: r.texts[1] || '', album: r.album, image: r.image,
      folderName: preview.group.folderName, group: preview.group, mediaUrl: r.mediaUrl, durationSec: r.durationSec,
    })), preview.name, false, explicitOpts);
    if (n) setQueued(new Set(previewTracks.filter((r) => !r.isSet).map(resultKey)));
    if (sets.length) onToast(`${sets.length} album${sets.length > 1 ? 's were' : ' was'} skipped — open one to add its tracks.`);
  };

  const loadProfile = (event) => {
    event.preventDefault();
    if (!profileName.trim() || busy) return;
    loadProfileFor(profileName.trim());
  };

  const loadProfileFor = async (name) => {
    setBusy('Finding public playlists…');
    setProfile(null);
    try {
      const out = await sources.resolve(name, { mode: 'spotify-profile' });
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

  // Reading one playlist of a profile. Deezer's own playlist rows already carry
  // each track's real album art at no extra cost (deezerPlaylist uses it
  // unconditionally), so only Spotify pays for this: one extra request per
  // track, multiplied by every playlist a profile holds. Worth it anyway - the
  // transport bar and queue otherwise show the same playlist cover for every
  // row, which reads as "this app doesn't know what it's downloading" - so the
  // playlist read concurrency below is halved to keep the total request burst
  // sane.
  const readPlaylist = (playlist, perTrackArtwork = true) => (
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
  const readOne = async (playlist, failed) => {
    let out = null;
    // Read all playlist metadata before requesting hundreds of track covers.
    try { out = await readPlaylist(playlist, false); }
    catch (e) { out = { error: e.message }; }
    if (!out || out.error) {
      const reason = (out && out.error) || 'unreadable';
      failed.push({ playlist, error: reason });
      console.error(`profile playlist read failed: ${playlist.name || playlist.id} — ${reason}`);
      return null;
    }
    return out;
  };

  const downloadProfile = async () => {
    if (!profile || busy) return;
    const info = profile.info || { service: profile.service, user: profile.user, name: profile.user };
    const meta = profileMeta(info);
    const list = profile.playlists;
    const failed = [];
    let readCount = 0;
    setBusy(`Reading playlists (0 of ${list.length})…`);
    try {
      const readPlaylists = (await mapPool(list, 2, async playlist => {
        const out = await readOne(playlist, failed);
        setBusy(`Reading playlists (${++readCount} of ${list.length})…`);
        return out ? { playlist, out } : null;
      })).filter(Boolean);

      if (!readPlaylists.length) {
        console.error(`profile read: 0/${list.length} playlists usable for ${info.name || info.user}`, failed);
        onToast(`Could not read any of ${info.name || info.user}'s playlists. ${failed[0]?.error || ''}`, 'err');
        return;
      }

      const ordered = order === 'default'
        ? readPlaylists
        : sortPlaylists(
            readPlaylists.map((r) => ({ ...r.playlist, tracks: r.out.results.length, _read: r })),
            order,
          ).map((r) => r._read);

      setBusy(`Deduplicating and preparing ${ordered.length} playlists…`);

      const rawPlaylists = [];
      const tracksMap = new Map();
      const firstPlaylistIdForKey = new Map();
      let totalPlaylistEntries = 0;

      for (const item of ordered) {
        const out = item.out;
        const plId = `${meta.id}|${out.group?.id || item.playlist.id}`;
        const plName = out.name || item.playlist.name || 'Playlist';
        const plRecord = {
          id: plId,
          name: plName,
          artwork: out.group?.artworkUrl || item.playlist.image || null,
          trackKeys: [],
        };

        for (const r of (out.results || [])) {
          totalPlaylistEntries++;
          let key;
          try {
            key = trackKey({
              isrc: r.isrc,
              service: r.service || meta.service,
              trackId: r.trackId,
              title: r.texts[0],
              artist: r.texts[1] || '',
            });
          } catch {
            continue;
          }

          plRecord.trackKeys.push(key);
          if (!firstPlaylistIdForKey.has(key)) firstPlaylistIdForKey.set(key, plId);
          if (!tracksMap.has(key)) {
            tracksMap.set(key, {
              title: r.texts[0],
              artist: r.texts[1] || '',
              album: r.album || null,
              image: r.image,
              artworkPending: r.artworkPending,
              durationSec: r.durationSec,
              service: r.service || meta.service,
              trackId: r.trackId,
              isrc: r.isrc,
            });
          }
        }

        rawPlaylists.push(plRecord);
      }

      const playlists = assignPlaylistFiles(rawPlaylists).map((pl) => ({
        ...pl,
        folderName: joinFolder(meta.folderName, pl.folder || pl.file),
      }));
      const plById = new Map(playlists.map((pl) => [pl.id, pl]));
      for (const [k, track] of tracksMap.entries()) {
        const ownerPl = plById.get(firstPlaylistIdForKey.get(k)) || playlists[0];
        tracksMap.set(k, {
          ...track,
          folderName: ownerPl?.folderName || meta.folderName,
        });
      }

      // Check existing library and manifest on disk to avoid re-downloading
      if (isElectron && ipc) {
        try {
          const existingLib = await ipc.invoke('profile-library-load', meta.folderName);
          if (existingLib && existingLib.tracks) {
            for (const [k, prev] of Object.entries(existingLib.tracks)) {
              if (tracksMap.has(k) && prev.status === 'downloaded' && prev.file) {
                const current = tracksMap.get(k);
                tracksMap.set(k, {
                  ...current,
                  status: 'downloaded',
                  file: prev.file,
                  bytes: prev.bytes,
                  savePath: prev.savePath,
                  transferService: prev.downloadService || null,
                });
              }
            }
          }
          const pendingEntries = [...tracksMap.entries()].filter(([, t]) => t.status !== 'downloaded');
          if (pendingEntries.length) {
            const checks = await ipc.invoke('downloads-check', pendingEntries.map(([k, t]) => ({
              key: k, folderName: t.folderName, title: t.title, artist: t.artist, durationSec: t.durationSec, isrc: t.isrc,
            })));
            pendingEntries.forEach(([k, current], i) => {
              if (checks?.[i]?.done) {
                tracksMap.set(k, {
                  ...current,
                  status: 'downloaded',
                  file: checks[i].file,
                  bytes: checks[i].bytes,
                  savePath: checks[i].savePath,
                  transferService: checks[i].service || null,
                });
              }
            });
          }
        } catch (e) {
          console.warn('Could not read existing library manifest:', e);
        }
      }

      const queuedTracks = getController().addProfile(meta, playlists, tracksMap);
      refreshSpotifyArtwork(getController(), sources).catch(error => console.warn('Artwork refresh failed:', error.message));

      const note = failed.length ? ` ${failed.length} playlist${failed.length === 1 ? '' : 's'} could not be read.` : '';
      const dedupedCount = totalPlaylistEntries - tracksMap.size;
      const dedupNote = dedupedCount > 0 ? ` (${dedupedCount} duplicate${dedupedCount === 1 ? '' : 's'} skipped)` : '';

      onToast(
        `Queued ${queuedTracks} unique track${queuedTracks === 1 ? '' : 's'} across ${playlists.length} playlists${dedupNote}.${note}`,
        queuedTracks ? undefined : 'err'
      );
    } catch (error) { onToast(error.message || 'Could not queue that profile.', 'err'); }
    finally { setBusy(null); }
  };


  // One playlist off a profile grid. It still lands under the user's folder:
  // adding two of someone's playlists by hand and then downloading the profile
  // should not scatter the same music across two different places.
  const queuePlaylist = async (playlist, explicitOpts = {}) => {
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
        ...r,
        title: r.texts[0], artist: r.texts[1] || '', image: r.image,
        folderName: group.folderName, group, profile: meta,
      })), out.name, false, explicitOpts);
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
      history.remember({ ...entry, at: Date.now() });
      return;
    }
    setMode('search');
    setArtistView(null);
    setQuery(entry.label);
    if (entry.kind === 'search') {
      setPreview(null);
      setResults(entry.results || []);
      setQueued(new Set());
      setSearchState('done');
      return;
    }
    await importLink(entry.label);
  };

  const openSet = async (row) => {
    if (!row.mediaUrl && !row.deezerAlbumId && !row.id) return;
    setSetModal({ title: row.title, artist: row.artist, image: row.image, loading: true });
    try {
      let out;
      if (row.deezerAlbumId || (row.isSet && row.id)) {
        const albumId = row.deezerAlbumId || row.id;
        out = await sources.deezerPlaylist({ id: albumId, type: 'album', name: row.title, image: row.image });
      } else {
        out = await sources.resolve(row.mediaUrl, { mode: 'auto', perTrackArtwork: true });
      }
      if (out.error) { setSetModal({ title: row.title, artist: row.artist, image: row.image, error: out.error }); return; }
      setSetModal({ title: row.title, artist: row.artist, image: row.image, preview: out });
      if (row.mediaUrl) {
        history.remember({ kind: 'link', label: row.mediaUrl, name: out.name, count: out.results.length,
                   image: out.group?.artworkUrl || row.image || '' });
      }
    } catch (error) {
      setSetModal({ title: row.title, artist: row.artist, image: row.image, error: error.message || 'Could not read that album.' });
    }
  };

  // An album card can go straight to the queue: the resolve behind it is the
  // same cached one the pop-up uses, so this costs a request only the first time.
  const queueSet = async (row, explicitOpts = {}) => {
    if (!row.mediaUrl && !row.deezerAlbumId && !row.id) return;
    setBusy(`Reading “${row.title}”…`);
    try {
      let out;
      if (row.deezerAlbumId || (row.isSet && row.id)) {
        const albumId = row.deezerAlbumId || row.id;
        out = await sources.deezerPlaylist({ id: albumId, type: 'album', name: row.title, image: row.image });
      } else {
        out = await sources.resolve(row.mediaUrl, { mode: 'auto', perTrackArtwork: true, onStatus: setBusy });
      }
      if (out.error) { onToast(out.error, 'err'); return; }
      if (row.mediaUrl) {
        history.remember({ kind: 'link', label: row.mediaUrl, name: out.name, count: out.results.length,
                   image: out.group?.artworkUrl || row.image || '' });
      }
      await queueItems(out.results.map((r) => toQueueItem({
        ...r,
        title: r.texts[0], artist: r.texts[1] || '', image: r.image,
        folderName: out.group?.folderName, group: out.group,
        album: out.name || row.title,
        durationSec: r.durationSec,
      })), out.name, false, explicitOpts);
    } catch (error) { onToast(error.message || 'Could not read that album.', 'err'); }
    finally { setBusy(null); }
  };

  const setModalItem = (r) => toQueueItem({
    ...r,
    title: r.texts[0], artist: r.texts[1] || '', image: r.image,
    folderName: setModal.preview?.group?.folderName, group: setModal.preview?.group,
    album: r.album || setModal.preview?.name || setModal.title,
    durationSec: r.durationSec,
  });

  const previewTracks = useMemo(() => preview?.results?.map((r) => ({
    ...r,
    title: r.texts?.[0] || r.title || '',
    artist: r.texts?.[1] || r.artist || '',
    image: r.image,
    durationSec: r.durationSec,
    mediaUrl: r.mediaUrl,
    isSet: r.isSet,
    album: r.album || null,
    id: r.id || null,
    deezerAlbumId: r.deezerAlbumId || null,
    trackCount: r.trackCount || null,
  })) || [], [preview]);
  const previewSongs = useMemo(() => previewTracks.filter((r) => !r.isSet), [previewTracks]);
  const previewSets = useMemo(() => previewTracks.filter((r) => r.isSet), [previewTracks]);

  const queuePreviewOne = async (result, explicitOpts = {}) => {
    const n = await queueItems([toQueueItem({ ...result, folderName: preview.group.folderName, group: preview.group })], preview.name, false, explicitOpts);
    if (n) setQueued((prev) => new Set(prev).add(resultKey(result)));
  };

  const artistResults = useMemo(() => results.filter((r) => r.isArtist), [results]);
  const albumResults = useMemo(() => results.filter((r) => r.isSet && !r.isArtist), [results]);
  const trackResults = useMemo(() => results.filter((r) => !r.isSet && !r.isArtist), [results]);
  const isQueuedResult = (r) => queued.has(resultKey(r));

  const showSearchResults = mode === 'search' && !artistView && !preview;

  return (
    <>
      <header className="topbar">
        <div><h1>Add music</h1><span className="topbar-sub">Lossless FLAC from Qobuz, Tidal, Deezer and more</span></div>
        {busy && <><span className="spacer" /><span className="pill accent live"><span className="dot" />{busy}</span></>}
      </header>

      <div className="pane">
        <div className="pane-inner">
          <div className="finder">
            <div className="mode-row">
              <div className="segmented" role="tablist" aria-label="Add music method">
                {MODES.map((item) => (
                  <button key={item.id} role="tab" aria-selected={mode === item.id}
                    className="seg-btn mode-tab" disabled={!!busy}
                    onClick={() => { setMode(item.id); setArtistView(null); }}>
                    <Icon name={item.icon} size={14} />{item.label}
                  </button>
                ))}
              </div>
            </div>

            {mode === 'search' && (
              <form className="finder-form" onSubmit={submit}>
                <div className="search-control">
                  <span className="search-icon" aria-hidden="true"><Icon name={isLink ? 'link' : 'search'} size={18} /></span>
                  <input
                    id="music-search"
                    className="input"
                    autoFocus
                    aria-label="Search music or paste a link"
                    placeholder="Search artists, albums, songs — or paste a Spotify / Deezer link"
                    value={query}
                    onChange={(e) => { setQuery(e.target.value); if (preview) setPreview(null); }}
                  />
                  {query && (
                    <button type="button" className="clear-input" aria-label="Clear" onClick={clearFinder}>
                      <Icon name="x" size={15} />
                    </button>
                  )}
                  <button className="btn btn-primary search-button" disabled={!query.trim() || !!busy}>
                    {isLink ? 'Preview' : searchState === 'loading' ? 'Searching…' : 'Search'}
                  </button>
                </div>
                <div className="form-foot">
                  {isLink ? (
                    <span><span className="input-kind"><Icon name="link" size={12} />Link</span> — nothing is queued until you review the tracks.</span>
                  ) : (
                    <>
                      <div className="chips" role="group" aria-label="Search category">
                        {SEARCH_FILTERS.map((f) => (
                          <button
                            key={f.id}
                            type="button"
                            className={`chip${searchFilter === f.id ? ' active' : ''}`}
                            aria-pressed={searchFilter === f.id}
                            onClick={() => { setSearchFilter(f.id); setArtistView(null); }}
                          >
                            {f.label}
                            {searchState === 'done' && f.id === 'tracks' && trackResults.length > 0 && <span>{trackResults.length}</span>}
                            {searchState === 'done' && f.id === 'albums' && albumResults.length > 0 && <span>{albumResults.length}</span>}
                            {searchState === 'done' && f.id === 'artists' && artistResults.length > 0 && <span>{artistResults.length}</span>}
                          </button>
                        ))}
                      </div>
                      <label className="folder-inline">
                        <Icon name="folder" size={13} />Save to folder
                        <input className="input" placeholder="Optional" value={folder} onChange={(e) => setFolder(e.target.value)} />
                      </label>
                    </>
                  )}
                </div>
              </form>
            )}

            {mode === 'profile' && (
              <form className="finder-form" onSubmit={loadProfile}>
                <div className="search-control">
                  <span className="search-icon" aria-hidden="true"><Icon name="user" size={18} /></span>
                  <input id="profile-search" className="input" autoFocus aria-label="Spotify username or profile link"
                    placeholder="Spotify username or profile link" value={profileName}
                    onChange={(e) => { setProfileName(e.target.value); setProfile(null); }} />
                  <button className="btn btn-primary search-button" disabled={!profileName.trim() || !!busy}>Show</button>
                </div>
                <div className="form-foot"><span>Only public playlists can be shown.</span></div>
                {recentProfiles.length > 0 && (
                  <div className="recent-profiles" aria-label="Recent profiles">
                    <div className="recent-profiles-head">
                      <span>Recent profiles</span>
                      {recentProfiles.length > 6 && <button type="button" className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => setMode('history')}>View all</button>}
                    </div>
                    <div className="recent-profile-list">
                      {recentProfiles.slice(0, 6).map(entry => (
                        <button key={entry.id} type="button" className="recent-profile" disabled={!!busy} onClick={() => openHistory(entry)}>
                          {entry.image ? <img src={entry.image} alt="" loading="lazy" /> : <span className="recent-profile-avatar" aria-hidden="true"><Icon name="user" size={16} /></span>}
                          <span className="recent-profile-copy">
                            <strong>{entry.name || entry.label}</strong>
                            <span>{entry.user || entry.label} · {entry.count ?? entry.results?.length ?? 0} playlists</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </form>
            )}

            {mode === 'history' && <div style={{ height: 'var(--s4)' }} />}
          </div>

          {/* Artist discography */}
          {mode === 'search' && artistView && (
            <section className="results-section">
              <div className="artist-hero">
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setArtistView(null)}>
                  <Icon name="arrowLeft" size={14} />Back
                </button>
                <div className="artist-hero-identity">
                  {artistView.image
                    ? <img src={artistView.image} alt="" className="artist-hero-avatar" />
                    : <div className="artist-hero-avatar"><Icon name="user" size={36} /></div>}
                  <div style={{ minWidth: 0 }}>
                    <span className="eyebrow">Artist</span>
                    <h2 className="truncate">{artistView.name}</h2>
                    {!artistView.loading && (
                      <p>{artistView.albums?.length || 0} releases · {artistView.topTracks?.length || 0} top tracks</p>
                    )}
                  </div>
                </div>
                {!artistView.loading && artistView.topTracks?.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!!busy}
                    onClick={() => queueItems(
                      artistView.topTracks.map((t) => toQueueItem({ ...t, folderName: safeFolder || sanitizeFolder(artistView.name) })),
                      `${artistView.name} Top Tracks`
                    )}
                  >
                    <Icon name="plus" size={15} />Queue top {artistView.topTracks.length}
                  </button>
                )}
              </div>

              {artistView.loading && <SkeletonGrid />}
              {artistView.error && (
                <div className="inline-empty"><strong>Could not load artist</strong><span>{artistView.error}</span></div>
              )}
              {!artistView.loading && !artistView.error && (
                <>
                  {artistView.topTracks?.length > 0 && (
                    <div className="result-block">
                      <div className="block-head"><h3>Popular</h3></div>
                      <SongList
                        rows={artistView.topTracks}
                        isQueued={isQueuedResult}
                        disabled={!!busy}
                        onAlbumClick={openSet}
                        onQueue={(t) => addSearchResult(t)}
                        onNow={(t) => addSearchResult(t, { priority: true, preempt: true })}
                      />
                    </div>
                  )}
                  {artistView.albums?.length > 0 && (
                    <div className="result-block">
                      <div className="block-head"><h3>Discography</h3><span>{artistView.albums.length} releases</span></div>
                      <div className="media-grid">
                        {artistView.albums.map((album) => (
                          <AlbumCard
                            key={resultKey(album)}
                            result={album}
                            queued={isQueuedResult(album)}
                            disabled={!!busy}
                            onOpen={() => openSet(album)}
                            action={() => addSearchResult(album)}
                            onDownloadNow={() => addSearchResult(album, { priority: true, preempt: true })}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {showSearchResults && searchState === 'idle' && (
            <div className="discovery-empty">
              <div className="empty-icon"><Icon name="music" size={24} /></div>
              <h2>Find music in lossless FLAC</h2>
              <p>
                Search by artist, album or song — or paste a Spotify, Deezer, Tidal, or Qobuz playlist,
                album or track link to review it before anything is downloaded.
              </p>
            </div>
          )}

          {showSearchResults && searchState === 'loading' && (
            <section className="results-section" aria-busy="true">
              <SkeletonGrid n={6} />
            </section>
          )}

          {showSearchResults && searchState === 'done' && (
            <section className="results-section">
              {!results.length ? (
                <div className="inline-empty"><strong>No matches</strong><span>Try fewer words or check the spelling.</span></div>
              ) : (
                <>
                  {(searchFilter === 'all' || searchFilter === 'tracks') && trackResults.length > 0 && (
                    <div className="result-block">
                      <div className="block-head">
                        <h3>Songs</h3>
                        {searchFilter === 'all' && trackResults.length > 6 && (
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSearchFilter('tracks')}>See all {trackResults.length}</button>
                        )}
                      </div>
                      <SongList
                        rows={searchFilter === 'all' ? trackResults.slice(0, 6) : trackResults}
                        isQueued={isQueuedResult}
                        disabled={!!busy}
                        onArtistClick={openArtist}
                        onAlbumClick={openSet}
                        onQueue={(r) => addSearchResult(r)}
                        onNow={(r) => addSearchResult(r, { priority: true, preempt: true })}
                      />
                    </div>
                  )}

                  {(searchFilter === 'all' || searchFilter === 'artists') && artistResults.length > 0 && (
                    <div className="result-block">
                      <div className="block-head">
                        <h3>Artists</h3>
                        {searchFilter === 'all' && artistResults.length > 6 && (
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSearchFilter('artists')}>See all {artistResults.length}</button>
                        )}
                      </div>
                      <div className="artist-grid">
                        {(searchFilter === 'all' ? artistResults.slice(0, 6) : artistResults).map((ar) => (
                          <ArtistCard key={resultKey(ar)} artist={ar} onOpen={openArtist} disabled={!!busy} />
                        ))}
                      </div>
                    </div>
                  )}

                  {(searchFilter === 'all' || searchFilter === 'albums') && albumResults.length > 0 && (
                    <div className="result-block">
                      <div className="block-head">
                        <h3>Albums</h3>
                        {searchFilter === 'all' && albumResults.length > 6 && (
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSearchFilter('albums')}>See all {albumResults.length}</button>
                        )}
                      </div>
                      <div className="media-grid">
                        {(searchFilter === 'all' ? albumResults.slice(0, 6) : albumResults).map((result) => (
                          <AlbumCard
                            key={resultKey(result)}
                            result={result}
                            queued={isQueuedResult(result)}
                            disabled={!!busy}
                            onOpen={() => openSet(result)}
                            onArtistClick={openArtist}
                            action={() => addSearchResult(result)}
                            onDownloadNow={() => addSearchResult(result, { priority: true, preempt: true })}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {mode === 'search' && !artistView && preview && !preview.error && (
            <section className="results-section">
              {preview.warning && <p className="banner warn-text" role="status">{preview.warning}</p>}
              <div className="results-heading">
                <div className="playlist-identity">
                  {preview.group.artworkUrl ? <img src={preview.group.artworkUrl} alt="" /> : <EmptyArtwork kind="playlist" />}
                  <div style={{ minWidth: 0 }}>
                    <span className="eyebrow">Review before downloading</span>
                    <h2 className="truncate">{preview.name}</h2>
                    <p>{preview.results.length} tracks · saves to {preview.group.folderName}</p>
                  </div>
                </div>
                <div className="row-actions">
                  <button className="btn btn-icon" onClick={() => queuePreview({ priority: true, preempt: true })} disabled={!!busy} title="Download all now (jump the queue)" aria-label="Download all now">
                    <Icon name="zap" size={15} />
                  </button>
                  <button className="btn btn-primary" onClick={() => queuePreview()} disabled={!!busy}>
                    <Icon name="plus" size={15} />Add all {previewSongs.length || preview.results.length}
                  </button>
                </div>
              </div>
              {previewSongs.length > 0 && (
                <SongList
                  rows={previewSongs}
                  isQueued={isQueuedResult}
                  disabled={!!busy}
                  onArtistClick={openArtist}
                  onQueue={(r) => queuePreviewOne(r)}
                  onNow={(r) => queuePreviewOne(r, { priority: true, preempt: true })}
                />
              )}
              {previewSets.length > 0 && (
                <div className="media-grid">
                  {previewSets.map((result, i) => (
                    <AlbumCard
                      key={`${result.title}-${i}`}
                      result={result}
                      disabled={!!busy}
                      onOpen={() => openSet(result)}
                      onArtistClick={openArtist}
                      action={() => queueSet(result)}
                      onDownloadNow={() => queueSet(result, { priority: true, preempt: true })}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {mode === 'profile' && profile && (
            <section className="results-section">
              <div className="results-heading">
                <div className="profile-identity">
                  {profile.info?.image
                    ? <img className="profile-avatar" src={profile.info.image} alt="" referrerPolicy="no-referrer" />
                    : <div className="profile-avatar" aria-hidden="true">{(profile.info?.name || profile.user || '?').slice(0, 1).toUpperCase()}</div>}
                  <div style={{ minWidth: 0 }}>
                    <span className="eyebrow">{profile.info?.service === 'deezer' ? 'Deezer profile' : 'Spotify profile'}</span>
                    <h2 className="truncate">{profile.info?.name || profile.user}</h2>
                    <p>{profile.playlists.length} public {profile.playlists.length === 1 ? 'playlist' : 'playlists'}
                      {profile.info?.name && profile.info.name !== profile.user ? ` · ${profile.user}` : ''}</p>
                  </div>
                </div>
                <div className="profile-actions">
                  <label className="order-inline">Download order
                    <select className="select" value={order} onChange={(e) => setOrder(e.target.value)} disabled={!!busy}>
                      {PROFILE_ORDERS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                  </label>
                  <button className="btn btn-primary" onClick={downloadProfile} disabled={!!busy || !profile.playlists.length}>
                    <Icon name="download" size={15} />Download whole profile
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
                  <div className="playlist-cover">
                    {playlist.image ? <img src={playlist.image} alt="" loading="lazy" /> : <EmptyArtwork kind="playlist" />}
                    <div className="cover-hover-actions">
                      <button type="button" className="hover-btn priority" onClick={() => queuePlaylist(playlist, { priority: true, preempt: true })} disabled={!!busy} title="Download playlist now" aria-label={`Download ${playlist.name} now`}>
                        <Icon name="zap" size={15} />
                      </button>
                      <button type="button" className="hover-btn primary" onClick={() => queuePlaylist(playlist)} disabled={!!busy} title="Queue playlist" aria-label={`Queue ${playlist.name}`}>
                        <Icon name="plus" size={18} strokeWidth={2.5} />
                      </button>
                    </div>
                  </div>
                  <div className="playlist-copy">
                    <h3 title={playlist.name}>{playlist.name}</h3>
                    <p>{playlist.tracks > 0 ? `${playlist.tracks} tracks` : (playlist.service === 'deezer' ? 'Deezer playlist' : 'Spotify playlist')}</p>
                  </div>
                </article>))}
              </div>
            </section>
          )}

          {mode === 'history' && (entries.length ? (
            <section className="results-section">
              <div className="results-heading">
                <div><span className="eyebrow">History</span><h2>{entries.length} past {entries.length === 1 ? 'lookup' : 'lookups'}</h2></div>
                <button className="btn btn-sm btn-ghost" onClick={() => history.clearHistory()}>Clear history</button>
              </div>
              <div>
                {groupByDay(entries).map((group) => (
                  <div className="history-group" key={group.label}>
                    <h3 className="history-day">{group.label}</h3>
                    {group.entries.map((entry) => <HistoryEntry key={entry.id} entry={entry} busy={busy}
                      onOpen={() => openHistory(entry)} onForget={() => history.forget(entry.id)} />)}
                  </div>
                ))}
              </div>
            </section>
          ) : (
            <div className="discovery-empty">
              <div className="empty-icon"><Icon name="history" size={24} /></div>
              <h2>Nothing searched yet</h2>
              <p>Searches and pasted links are kept here, newest first, so you can open one again without typing it out.</p>
            </div>
          ))}
        </div>
      </div>

      {setModal && <SetModal state={setModal} busy={busy} onClose={() => setSetModal(null)}
        onOpenArtist={openArtist}
        onQueueAll={() => queueItems(setModal.preview.results.map(setModalItem), setModal.preview.name)}
        onDownloadAllNow={() => queueItems(setModal.preview.results.map(setModalItem), setModal.preview.name, false, { priority: true, preempt: true })}
        onQueueOne={(r) => queueItems([setModalItem(r)], setModal.preview.name)}
        onDownloadOneNow={(r) => queueItems([setModalItem(r)], setModal.preview.name, false, { priority: true, preempt: true })} />}
    </>
  );
}
