import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { installRendererLogging } from './diagnostics.js';
import './styles.css';

// Before React, deliberately: an exception thrown while the app is booting is
// the one most worth having, and it happens before any component could install
// a handler of its own.
if (typeof window !== 'undefined' && typeof window.require === 'function') {
  const ipc = window.require('electron').ipcRenderer;
  installRendererLogging((evt, data) => ipc.send('log', { evt, data }));
}

createRoot(document.getElementById('root')).render(
  // StrictMode double-invokes effects in development on purpose. That is safe
  // here precisely because the download engine is NOT React state: it lives
  // outside the tree and is only subscribed to, so a double-mount cannot start
  // a scrape twice or tear down a transfer in flight.
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
