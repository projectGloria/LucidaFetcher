# Codebase review and reliability fixes — 2026-10-18

Read the application entry point, every engine and UI module, JSX views and
components, stylesheet, build/lint configuration, maintenance scripts, test
fixtures and regressions, and prior review notes. Installed dependencies,
generated bundles and binary assets were excluded. Existing uncommitted changes
were preserved; the changes below build on that working tree.

## Sound toggle and blank interface

**Follow-up: reproduced and fixed after the user confirmed the failure persisted.**
The previous checks used `input.click()`, which toggles the checkbox without
focusing it. A real mouse click on its label focuses the hidden input and triggers
browser scrolling. `.switch input` was absolutely positioned without a positioned
label ancestor, so its position was tied to the document rather than its scrolling
pane. Focusing the sound checkbox scrolled the document down **869 pixels**,
moving the entire application shell to `top: -869px`, including the sidebar. The
DOM and accessibility tree remained present and no React exception occurred.

The fix anchors each checkbox to its switch with a positioned label and explicit
input bounds. The document also uses `overflow: clip` so only the intended panes
scroll. Injecting just the positioning correction into the reproduced blank
window, then resetting document scroll, restored the same UI without restarting
React or the download engine. A subsequent physical toggle retained the shell.

The Electron smoke tests now send trusted mouse input to the visible label,
verify actual checkbox focus and value, and require `scrollY === 0` and shell
`top === 0`. The updated check fails against the previous packaged archive with
the measured 869-pixel displacement and passes against the corrected source.

An older application log records sounds enabled, followed later
by GPU and renderer processes ending with reason `killed`. This is evidence of
process termination, not proof of an audio-triggered crash: externally killing
those processes can produce the same events. There is no captured JavaScript
rendering exception establishing the reported cause.

Earlier sound hardening (not the cause of the blank window):

- Reserve note slots before awaiting the device. Previously, the live-node cap
  did not bound playback requests pending a suspended device.
- Share one in-flight resume operation per audio context.
- Discard pending cues when sounds are disabled, and allow a replacement device
  to play without waiting for the old one.
- Disconnect an oscillator if creating its gain node fails. Previously, that
  throw happened before the cleanup handler was installed.

These earlier audio changes extend the existing device-error handling, mute
behavior, node cleanup, volume-save batching and React recovery boundaries
already in the working tree.
React boundaries cannot recover a terminated Chromium process.

## Other verified fixes

| Problem | Result |
| --- | --- |
| Plain text in Paste a link resolves to a text result without a group or track list; the preview then throws while rendering | Validate preview results before storing them, including results opened from history; explain supported links in a toast |
| Unexpected failures while preparing a whole profile leave the view permanently busy | Catch the failure, report it, and clear busy state in `finally` |
| A second App mount can resolve engine initialization while the first mount is still restoring saved work | All mounts and `whenReady()` await the same initialization promise |
| Slow profile validation/copying queues every intermediate snapshot | Keep the active pass and one latest pending snapshot per destination; newer snapshots still run if an earlier pass fails, and shutdown waits for the registered task |

## Verification

- `npm test`: **276 passing, zero failures**; baseline was 268 passing.
- `npm run lint`: clean.
- `npm run test:electron`: passes against the production React bundle.
- Packaged-archive Electron check: passes against
  `release/2026-10-18-sound-focus-fix/win-unpacked/resources/app.asar`, including
  four trusted mouse clicks that focus the checkbox and keep the shell at zero.
- Saved-queue check: 1,175 tracks restored, 11 trusted mouse sound toggles,
  document scroll stays zero, navigation retained, volume visible and painted
  window captured.
- Visible desktop check using the corrected packaged archive: real mouse clicks
  enabled and disabled sounds, with the sidebar and Settings still painted in
  both settled screenshots. This used isolated copied state and blocked remote
  requests, and did not change the original queue or music files.
- A burst of 1,000 cues waiting on a suspended device makes one resume request
  and schedules at most 12 notes.
- With a profile pass blocked, 100 subsequent updates result in two filesystem
  passes total: the active version and the latest version.
- Existing integration checks also cover recovery from a React exception,
  80 progress updates across 10,001 rows without rebuilding the list, local FLAC
  transfers, recording rejection, cover repair, shared copies, pause/resume and
  clean shutdown.

## Download view, profile history and provider icons

- Downloads stores collapsed profile/playlist IDs and its selected filter in
  `config.queueView`. Navigation and startup restore the saved choices.
  Collapse/expand all changes only visible groups, preserving choices hidden
  by a status filter.
- The profile search form lists the six most recent saved profiles directly
  below the input, with a link to the full history when there are more.
  Opening a saved profile immediately restores its cached public playlists
  without another profile search and moves it to the top of history.
- Spotify metadata no longer serves as a fallback download-provider icon.
  Completed rows show a recorded provider, or omit the icon when the provider
  was never recorded. Restore keeps metadata service and download service
  separate, including manifest lookups, resumed transfers and profile libraries.
- Unit regressions cover metadata/provider separation, restored profile rows,
  and attribution only when the manifest points to the same recorded file.
- Production and packaged UI checks cover collapse/filter state across
  navigation and reload, hidden filter choices, saved profile results without
  HTTP calls, and a Spotify-imported track displaying its Qobuz download icon.
- An isolated read-only copy of the user's queue (1,175 tracks, 121 playlists)
  and history passes navigation persistence, recent-profile opening, corrected
  icons and the existing eleven trusted sound-click checks. Original state and
  audio files were not changed.
- Updated portable: `release/2026-10-18-navigation-fix/LucidaFetcher-UI-Update-Portable.exe`.
  Its `win-unpacked/resources/app.asar` passes the integration checks above.

## Remaining limits

`downloads-check` still performs synchronous FLAC structure and artwork checks
on the main process before asynchronous identity validation. Large libraries on
slow disks can therefore delay startup/import responsiveness. Structural queue
updates also still expand playlist memberships and render expanded groups;
progress-only updates avoid that work, but this is not full list virtualization.

Live provider availability, changed remote markup and long-running memory behavior
have not been established by the controlled local fixtures. The sound-toggle
blank-window trigger above is reproduced. Its corrected portable build is in
`release/2026-10-18-sound-focus-fix/`, separate from the earlier portable that
still contains the positioning defect.
