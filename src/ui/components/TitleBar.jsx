import { useEffect, useState } from 'react';
import { isElectron, ipc } from '../engine.js';

// Caption glyphs drawn at 10px on a 1px stroke, the size and weight Windows 11
// uses for its own caption buttons. The 24px Icon set is wrong here: scaled
// down to caption size its 2px strokes go soft and read heavier than every
// other window on the desktop.
const GLYPHS = {
  minimize: <path d="M0 5.5h10" />,
  maximize: <rect x="0.5" y="0.5" width="9" height="9" rx="1" />,
  restore: <><rect x="0.5" y="2.5" width="7" height="7" rx="1" /><path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" /></>,
  close: <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />,
};

function Glyph({ name }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true" focusable="false">
      {GLYPHS[name]}
    </svg>
  );
}

/**
 * The window's own caption strip, replacing the native title bar
 * (`frame: false` in main.js).
 *
 * The strip itself is the drag region (`-webkit-app-region: drag` in CSS), so
 * Windows still handles move, double-click-to-maximize and Aero Snap natively -
 * none of that is reimplemented here. Only the three buttons are ours, and they
 * opt out of the drag region or they would never receive a click.
 *
 * Rendered by the splash and the boot-failure screen too: a frameless window
 * that fails to boot must still be movable and closable.
 */
export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isElectron) return undefined;
    let alive = true;
    // Ask once for the starting state (the window may open maximized from a
    // previous session), then follow main's events for every later change.
    ipc.invoke('window-state').then((s) => { if (alive && s) setMaximized(!!s.maximized); }).catch(() => { /* older main without the channel */ });
    const onState = (event, s) => setMaximized(!!(s && s.maximized));
    ipc.on('window-state', onState);
    return () => { alive = false; ipc.removeListener('window-state', onState); };
  }, []);

  // In the browser preview there is no window to drive; the strip still renders
  // so the layout matches the real app.
  const send = (action) => { if (isElectron) ipc.send('window-control', action); };

  return (
    <div className="titlebar">
      <div className="titlebar-drag" />
      <div className="caption-buttons">
        <button type="button" className="caption-btn" onClick={() => send('minimize')} title="Minimize" aria-label="Minimize" tabIndex={-1}>
          <Glyph name="minimize" />
        </button>
        <button
          type="button"
          className="caption-btn"
          onClick={() => send('toggle-maximize')}
          title={maximized ? 'Restore' : 'Maximize'}
          aria-label={maximized ? 'Restore' : 'Maximize'}
          tabIndex={-1}
        >
          <Glyph name={maximized ? 'restore' : 'maximize'} />
        </button>
        <button type="button" className="caption-btn close" onClick={() => send('close')} title="Close" aria-label="Close" tabIndex={-1}>
          <Glyph name="close" />
        </button>
      </div>
    </div>
  );
}
