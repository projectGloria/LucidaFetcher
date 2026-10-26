import { mapPool } from './sources.mjs';

// How often fetched covers are handed to the store. Each updateArtwork() is an
// emit, and an image change alters the profile library signature - so applying
// every batch of 8 meant one full profile-library sync in main per 8 tracks
// (~375 of them for a 3,000-track profile at launch). A few seconds still shows
// covers arriving progressively.
const APPLY_EVERY_MS = 5000;

// Refresh covers after the track list is queued. A removed or replaced record
// must never be recreated by a late response from Spotify.
export async function refreshSpotifyArtwork(controller, sources, { now = Date.now } = {}) {
  const covers = new Set([...controller.playlists.values()].map(p => p.artwork).filter(Boolean));
  const records = [...controller.tracks.values(), ...controller.items.values()];
  const pending = records.filter(({ item }) => (item.service === 'spotify' || item.originalService === 'spotify') && item.trackId
    && (item.artworkPending || !item.image || covers.has(item.image)));
  let buffered = [];
  let lastApply = now();
  const apply = () => {
    if (buffered.length && !controller._disposed) controller.updateArtwork(buffered);
    buffered = [];
    lastApply = now();
  };
  for (let at = 0; at < pending.length && !controller._disposed; at += 8) {
    const updates = await mapPool(pending.slice(at, at + 8), 2, async ({ item }) => {
      if (controller._disposed || controller.getItem(item.id)?.item !== item) return null;
      try {
        const image = await sources.spotifyTrackArtwork(item.trackId);
        return image ? { id: item.id, item, image } : null;
      } catch { return null; }
    });
    buffered.push(...updates.filter(Boolean));
    if (now() - lastApply >= APPLY_EVERY_MS) apply();
  }
  apply();
}
