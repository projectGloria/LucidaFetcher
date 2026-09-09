// "Download this whole profile" has to end with an answer, not just a queue
// that stopped moving.
//
// The per-folder report in main.js says what happened to one playlist. Nothing
// says what happened to the forty of them a profile download queued, and that
// is the only question the user actually asked. This turns the controller's
// records back into that answer.
//
// Pure on purpose: the wiring that sends it lives in renderer-integration, and
// everything that decides WHAT is sent - is the profile finished, which track
// went where, why a track was abandoned - is testable without Electron.

const TERMINAL = new Set(['completed', 'skipped', 'cancelled']);

/** A stable description of a profile's outcome, so the same finished profile is
 *  not written twice while the queue sits there doing nothing, but a retry that
 *  turns a missing track into a downloaded one IS written again. */
export function profileSignature(group) {
  return `${group.total}:${group.downloadedCount}:${group.missingCount}`;
}

/**
 * Every profile in the queue, whether or not it has finished.
 *
 * Playlists keep the order their tracks were queued in, which is the order the
 * user chose - a report that re-sorted them would be describing a run that
 * never happened.
 */
export function collectProfiles(items) {
  const profiles = new Map();
  for (const rec of items) {
    const it = rec.item || {};
    if (!it.profileId) continue;
    let p = profiles.get(it.profileId);
    if (!p) {
      p = {
        id: it.profileId,
        folderName: it.profileFolder || null,
        order: it.profileOrder || null,
        profile: {
          service: it.profileService || null,
          user: it.profileUser || null,
          name: it.profileName || it.profileUser || null,
          image: it.profileArtwork || null,
        },
        playlists: [],
        byPlaylist: new Map(),
        total: 0,
        finishedCount: 0,
        downloadedCount: 0,
        missingCount: 0,
      };
      profiles.set(it.profileId, p);
    }
    const key = it.groupId || '__loose__';
    let pl = p.byPlaylist.get(key);
    if (!pl) {
      pl = {
        name: it.groupName || 'Playlist',
        folder: it.folderName || null,
        counts: { downloaded: 0, missing: 0, pending: 0 },
        downloaded: [],
        missing: [],
      };
      p.byPlaylist.set(key, pl);
      p.playlists.push(pl);
    }

    p.total++;
    const entry = { title: it.title, artist: it.artist || null };
    if (rec.status === 'completed') {
      p.finishedCount++; p.downloadedCount++; pl.counts.downloaded++;
      // `via` is the store the file actually came from - which of the six was
      // it, in the end - and the whole point of trying them in an order.
      pl.downloaded.push({ ...entry, via: rec.statusText || null });
    } else if (rec.status === 'skipped') {
      p.finishedCount++; p.missingCount++; pl.counts.missing++;
      // The tried list is the part that cannot be reconstructed later: it is
      // the difference between "not on any store" and "the run gave up early".
      pl.missing.push({ ...entry, reason: rec.statusText || null, tried: rec.tried || [] });
    } else if (rec.status === 'cancelled') {
      p.finishedCount++;
    } else {
      pl.counts.pending++;
    }
  }
  return [...profiles.values()].map(({ byPlaylist, ...rest }) => ({
    ...rest,
    done: rest.total > 0 && rest.finishedCount === rest.total,
  }));
}

/** The payload main.js's 'profile-report' handler expects. */
export function reportPayload(group) {
  return {
    folderName: group.folderName,
    profile: group.profile,
    order: group.order,
    playlists: group.playlists,
  };
}

export const isTerminal = (status) => TERMINAL.has(status);
