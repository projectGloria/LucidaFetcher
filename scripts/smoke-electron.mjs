// An isolated Electron integration check: real webviews, cascades, IPC and
// Chromium downloads against a local fixture. Never reads the user's queue.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../', import.meta.url));
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidafetcher-smoke-'));
const require = createRequire(import.meta.url);
const electron = require('electron');
const packaged = process.argv.includes('--packaged');
const archiveArg = process.argv.indexOf('--archive');
const packageArchive = archiveArg >= 0 ? path.resolve(process.argv[archiveArg + 1]) : path.join(root, 'release/win-unpacked/resources/app.asar');
const stateRoot = path.join(sandbox, packaged ? 'userData' : '');

async function probeSourceResponses(baseUrl) {
  const ipc = window.require('electron').ipcRenderer;
  const view = document.createElement('webview');
  view.setAttribute('src', 'about:blank');
  const ready = new Promise(resolve => view.addEventListener('dom-ready', resolve, { once: true }));
  document.body.appendChild(view);
  await ready;
  const webContentsId = view.getWebContentsId();
  try {
    for (const status of [429, 403]) {
      const itemId = 'response-probe-' + status;
      ipc.send('set-next-download-folder', { webContentsId, itemId, sourceUrl: baseUrl, service: 'qobuz' });
      await ipc.invoke('get-config'); // IPC barrier before navigation
      const loaded = new Promise(resolve => view.addEventListener('dom-ready', resolve, { once: true }));
      const response = await new Promise((resolve, reject) => {
        const handler = (_event, value) => {
          if (value.itemId !== itemId) return;
          clearTimeout(timer);
          ipc.removeListener('source-response', handler);
          resolve(value);
        };
        const timer = setTimeout(() => { ipc.removeListener('source-response', handler); reject(new Error('No source response for ' + status)); }, 4000);
        ipc.on('source-response', handler);
        view.setAttribute('src', baseUrl + '/http-' + status);
      });
      if (response.status !== status || !response.mainFrame || (status === 429 && response.retryAfter !== '2')) {
        throw new Error('Incorrect source response: ' + JSON.stringify(response));
      }
      // Headers arrive before the page commits. Starting the next navigation
      // immediately can abort both Chromium loads and invalidate this probe.
      await loaded;
    }
  } finally {
    ipc.send('clear-download-context', webContentsId);
    view.remove();
  }
}

async function checkCustomBackend() {
  const input = document.getElementById('monochrome-api');
  if (!input) throw new Error('Custom Monochrome API setting missing');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const apply = input.parentElement.querySelector('button');
  const update = async value => {
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
    apply.click();
    await new Promise(resolve => setTimeout(resolve, 20));
    return window.require('electron').ipcRenderer.invoke('get-config');
  };
  let saved = await update('http://127.0.0.1:8000/');
  if (saved.monochromeApiUrl !== 'http://127.0.0.1:8000') throw new Error('Custom backend was not saved');
  saved = await update('file:///invalid');
  if (saved.monochromeApiUrl !== 'http://127.0.0.1:8000' || !document.getElementById('monochrome-api-error')) {
    throw new Error('Invalid custom backend replaced the working setting');
  }
  saved = await update('');
  if (saved.monochromeApiUrl !== '' || document.getElementById('monochrome-api-error')) throw new Error('Custom backend was not cleared');
  const pane = document.querySelector('.main .pane');
  pane.scrollTop += input.getBoundingClientRect().top - pane.getBoundingClientRect().top - 100;
}

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, args, { windowsHide: true, env });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(output || `Exit ${code}`)));
  });
}

try {
  const fixtureDir = path.join(sandbox, 'ui-fixture');
  await build({ configFile: false, logLevel: 'error', plugins: [react()], build: {
    outDir: fixtureDir,
    rolldownOptions: { input: path.join(root, 'test/ui-fixture.jsx'), output: { entryFileNames: 'fixture.js' } },
  } });
  await fs.writeFile(path.join(fixtureDir, 'index.html'), '<div id="root"></div><script type="module" src="./fixture.js"></script>');
  if (packaged) await fs.copyFile(packageArchive, path.join(sandbox, 'app.asar'));
  else for (const name of ['main.js', 'dist', 'build', 'src/engine']) await fs.cp(path.join(root, name), path.join(sandbox, name), { recursive: true });
  await fs.mkdir(path.join(stateRoot, 'state'), { recursive: true });
  await fs.mkdir(path.join(sandbox, 'downloads'));
  await fs.writeFile(path.join(stateRoot, 'state', 'config.json'), JSON.stringify({
    downloadPath: path.join(sandbox, 'downloads'), concurrency: 1, fallbackServices: ['qobuz'], closeToTray: false,
  }));
  // ffmpeg is only needed for this optional integration check, never by the app.
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-f', 'lavfi', '-i', 'color=c=black:s=32x32', '-t', '0.2', '-map', '0:a', '-map', '1:v',
    '-c:a', 'flac', '-c:v', 'png', '-disposition:v', 'attached_pic', path.join(sandbox, 'fixture.flac')]);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(sandbox, 'fixture.flac'),
    '-map', '0', '-c', 'copy', '-metadata', 'title=Other (Remix)', '-metadata', 'artist=Fixture', path.join(sandbox, 'wrong.flac')]);
  await fs.writeFile(path.join(sandbox, 'artwork.rgb'), randomBytes(1200 * 1200 * 3));
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '1200x1200',
    '-i', path.join(sandbox, 'artwork.rgb'), '-frames:v', '1', path.join(sandbox, 'large.png')]);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(sandbox, 'fixture.flac'), '-i', path.join(sandbox, 'large.png'),
    '-map', '0:a', '-map', '1:v', '-c', 'copy', '-disposition:v', 'attached_pic', path.join(sandbox, 'large.flac')]);
  // A zero total-sample count is valid FLAC and occurs in streamed exports.
  const unknownCount = await fs.readFile(path.join(sandbox, 'large.flac'));
  unknownCount.writeBigUInt64BE(unknownCount.readBigUInt64BE(18) & ~0xfffffffffn, 18);
  await fs.writeFile(path.join(sandbox, 'large.flac'), unknownCount);
  const fixtureBytes = (await fs.stat(path.join(sandbox, 'fixture.flac'))).size;
  const savedLists = ['a', 'b'].map((id, i) => ({ id: 'fixture-list-' + id, profileId: 'fixture-profile',
    name: 'Saved Mix ' + id.toUpperCase(), service: 'spotify', trackKeys: [i ? 'fixture-missing' : 'fixture-done'] }));
  await fs.writeFile(path.join(stateRoot, 'state', 'queue.json'), JSON.stringify({
    v: 4, paused: true, items: [], profiles: [{ id: 'fixture-profile', name: 'Saved Fixture', user: 'fixture',
      service: 'spotify', folderName: 'Saved Fixture' }], playlists: savedLists,
    tracks: [
      { id: 'fixture-done', key: 'fixture-done', title: 'Stored Song', artist: 'Fixture', service: 'spotify',
        transferService: 'qobuz', status: 'completed', savePath: path.join(sandbox, 'fixture.flac'), bytes: fixtureBytes },
      { id: 'fixture-missing', key: 'fixture-missing', title: 'Missing Song', artist: 'Fixture', service: 'spotify', status: 'skipped' },
    ],
  }));
  await fs.writeFile(path.join(stateRoot, 'state', 'history.json'), JSON.stringify([
    { id: 'h-fixture', kind: 'profile', label: 'fixture', user: 'fixture', name: 'Saved Fixture', count: 2,
      at: Date.now(), info: { service: 'spotify', user: 'fixture', name: 'Saved Fixture' }, results: savedLists },
  ]));
  const engineUrl = new URL('../src/engine/renderer-integration.mjs', import.meta.url).href;
  const checkNavigation = async (restored = false) => {
    const ipc = window.require('electron').ipcRenderer;
    const delay = () => new Promise(resolve => setTimeout(resolve, 75));
    const nav = async label => {
      [...document.querySelectorAll('.nav-item')].find(el => el.textContent.includes(label)).click();
      await delay();
    };
    const group = id => [...document.querySelectorAll('.group-head')].find(el => el.getAttribute('aria-controls') === 'group-body-' + id);
    await nav('Downloads');
    if (!restored) {
      const icon = document.querySelector('.row.done .trail .src-icon');
      if (icon?.getAttribute('alt') !== 'Qobuz') throw new Error('Restored download shows the metadata service instead of Qobuz');
      group('fixture-list-a').click(); await delay();
      await nav('Settings'); await nav('Downloads');
      if (group('fixture-list-a')?.getAttribute('aria-expanded') !== 'false') throw new Error('Playlist collapse was lost on navigation');
      [...document.querySelectorAll('.topbar button')].find(el => el.textContent === 'Missing').click(); await delay();
      [...document.querySelectorAll('.topbar button')].find(el => el.textContent === 'Collapse all').click(); await delay();
      await nav('Add music'); await nav('Downloads');
    }
    if (document.querySelector('.profile-head')?.getAttribute('aria-expanded') !== 'false' ||
        ![...document.querySelectorAll('.topbar button')].some(el => el.textContent === 'Missing' && el.getAttribute('aria-pressed') === 'true')) {
      throw new Error('Download view choices were not retained' + (restored ? ' after reload' : ' after navigation'));
    }
    const prefs = (await ipc.invoke('get-config')).queueView;
    if (prefs.filter !== 'missing' || !['fixture-profile', 'fixture-list-a', 'fixture-list-b'].every(id => prefs.collapsed.includes(id))) {
      throw new Error('Filtered collapse discarded hidden playlist preferences: ' + JSON.stringify(prefs));
    }
    await nav('Add music');
    [...document.querySelectorAll('.mode-tab')].find(el => el.textContent.includes('Spotify profile')).click(); await delay();
    const recent = document.querySelector('.recent-profile');
    if (!recent?.textContent.includes('Saved Fixture') || !document.querySelector('#profile-search').closest('form').contains(recent)) {
      throw new Error('Saved profile is not directly below the search box');
    }
    // Reopening saved results must not submit the enclosing profile search form.
    const invoke = ipc.invoke;
    let requests = 0;
    ipc.invoke = function (channel, ...args) {
      if (channel.startsWith('http-')) requests++;
      return invoke.call(this, channel, ...args);
    };
    try {
      recent.click(); await delay();
      if (requests || document.querySelectorAll('.playlist-grid .playlist-card').length !== 2 ||
          document.querySelector('#profile-search').value !== 'fixture' || !document.querySelector('.profile-identity').textContent.includes('Saved Fixture')) {
        throw new Error('Saved profile did not reopen cached playlists without searching');
      }
    } finally { ipc.invoke = invoke; }
    return prefs;
  };
  const checkSounds = async () => {
    const ipc = window.require('electron').ipcRenderer;
    const delay = () => new Promise(resolve => setTimeout(resolve, 25));
    const toggle = () => [...document.querySelectorAll('label.switch')].find(label => label.textContent.includes('Play a sound')).querySelector('input');
    const alive = () => {
      if (!document.querySelector('.app .sidebar') || !document.querySelector('.main h1')) throw new Error('Sound controls blanked the interface');
    };
    toggle().click(); await delay(); alive();
    if (!toggle().checked) throw new Error('Sound switch does not reflect its enabled state');
    if (!document.querySelector('#vol')) throw new Error('Sound volume is missing');
    let writes = 0;
    const send = ipc.send;
    ipc.send = function (channel, patch, ...args) {
      if (channel === 'set-config' && 'soundVolume' in patch) writes++;
      return send.call(this, channel, patch, ...args);
    };
    try {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const value of ['0.4', '0.5', '0.6', '0.7']) {
        const slider = document.querySelector('#vol');
        set.call(slider, value); slider.dispatchEvent(new Event('input', { bubbles: true }));
        await delay(); alive();
      }
      if (writes) throw new Error('Volume drag wrote settings before release');
      document.querySelector('#vol').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await delay();
      if (writes !== 1) throw new Error('Volume release must save once, saved ' + writes);
    } finally { ipc.send = send; }
    const saved = await ipc.invoke('get-config');
    if (saved.sounds !== true || saved.soundVolume !== 0.7) throw new Error('Sound preferences were not saved');
    // A failed audio driver must also leave the actual built interface usable.
    toggle().click(); await delay();
    const original = window.AudioContext;
    try {
      window.AudioContext = class { constructor() { throw new Error('fixture: unavailable audio device'); } };
      toggle().click(); await delay(); alive();
      toggle().click(); await delay();
      window.AudioContext = class {
        state = 'suspended';
        resume() { return Promise.reject(new Error('fixture: device disconnected')); }
        close() { return Promise.resolve(); }
      };
      toggle().click(); await delay(); alive();
      toggle().click(); await delay();
    } finally { window.AudioContext = original; }
    toggle().click(); await delay(); alive();
    document.querySelector('.main .pane').scrollTop = 100000;
    return (await ipc.invoke('get-config')).sounds;
  };
  const checkLinkPreview = async () => {
    const delay = () => new Promise(resolve => setTimeout(resolve, 50));
    [...document.querySelectorAll('.nav-item')].find(button => button.textContent.includes('Add music')).click();
    await delay();
    [...document.querySelectorAll('.mode-tab')].find(button => button.textContent.includes('Search or paste a link')).click();
    await delay();
    // Search and links share one box; a URL routes to the link path, so an
    // unsupported one must be explained rather than searched for as text.
    const input = document.querySelector('#music-search');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://example.com/not-music');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await delay();
    input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await delay();
    if (document.querySelector('.main [role="alert"]:not(.toast)') || !document.querySelector('#music-search') || !document.querySelector('.sidebar')) {
      throw new Error('An unsupported link broke the interface');
    }
    if (![...document.querySelectorAll('.toast.err')].some(toast => toast.textContent.includes('not a Spotify or Deezer'))) {
      throw new Error('Unsupported link did not explain which links are supported');
    }
  };
  const renderer = `
    (async () => {
      const { startEngine } = await import(${JSON.stringify(engineUrl)});
      const ipc = window.require('electron').ipcRenderer;
      const container = document.createElement('div');
      document.body.appendChild(container);
      const c = startEngine({ ipcRenderer: ipc, container, services: ['qobuz'], concurrency: 2, keepTrying: true });
      c.retryDelayMs = 100; c.retryMaxDelayMs = 200;
      let pausedTransfer = false;
      c.subscribe(() => {
        if (!pausedTransfer && c.getItems().some(rec => ['ready', 'downloading'].includes(rec.status))) {
          pausedTransfer = true;
          c.pause();
          setTimeout(() => c.resume(), 100);
        }
      });
      await Promise.all([...container.querySelectorAll('webview')].map(view => new Promise(resolve => {
        view.addEventListener('dom-ready', resolve, { once: true });
      })));
      c.add(['Retry', 'Other', 'Large'].map(title => ({ id: title, key: title, title, artist: 'Fixture', searchVariants: [title] })));
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error(JSON.stringify(c.getItems()))); }, 20000);
        const off = c.subscribe(() => {
          if (c.stats.completed === 3) { clearTimeout(timer); off(); resolve(c.getItems().map(rec => rec.result)); }
        });
      });
      c.pause(); c.resume();
      const tracks = Object.fromEntries(result.slice(0, 2).map((done, i) => ['shared-' + i, {
        title: 'Profile Song ' + i, artist: 'Fixture', status: 'downloaded',
        file: done.file, savePath: done.savePath, bytes: done.bytes,
      }]));
      const lists = [0, 1].map(i => ({ id: 'owner-' + i, name: 'Mix', file: 'Playlists/Mix.m3u8', artwork: 'https://art.fixture/' + i, trackKeys: ['shared-' + i] }));
      c.addProfile({ id: 'owner', folderName: 'Owner' }, lists, tracks);
      c.addProfile({ id: 'second', folderName: 'Second' }, [{ id: 'second-list', name: 'Mix', artwork: 'https://art.fixture/second', trackKeys: ['shared-0', 'shared-1'] }], tracks);
      // Library sync is asynchronous; wait for validated files and covers,
      // then main checks the playlist folders and shared copies below.
      const until = Date.now() + 10000;
      let libraries;
      while (true) {
        const a = await ipc.invoke('profile-library-load', 'Owner');
        const b = await ipc.invoke('profile-library-load', 'Second');
        if (Object.values(a.tracks).length === 2 && Object.values(b.tracks).length === 2 &&
            [...Object.values(a.tracks), ...Object.values(b.tracks)].every(t => t.status === 'downloaded' && t.savePath) &&
            [...a.playlists.map(pl => ['Owner', pl]), ...b.playlists.map(pl => ['Second', pl])].every(([folder, pl]) =>
              window.require('fs').existsSync(window.require('path').join(${JSON.stringify(path.join(sandbox, 'downloads'))}, folder, pl.folder, 'cover.png')))) { libraries = [a, b]; break; }
        if (Date.now() > until) throw new Error('Profile libraries never became valid: ' + JSON.stringify({ a, b }));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      c.dispose();
      return { downloads: result, libraries };
    })()
  `;
  const bootstrap = `
    const { app, BrowserWindow, session, ipcMain, net, nativeImage } = require('electron');
    const fs = require('fs'); const path = require('path'); const http = require('http');
    const fetch = net.fetch.bind(net);
    const cover = nativeImage.createFromPath(path.join(__dirname, 'large.png')).resize({ width: 64, height: 64 }).toPNG();
    net.fetch = (url, opts) => String(url).startsWith('https://art.fixture/')
      ? Promise.resolve(new Response(cover, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(cover.length) } }))
      : fetch(url, opts);
    app.setPath('userData', path.join(__dirname, 'userData'));
    if (${packaged}) {
      Object.defineProperty(app, 'isPackaged', { value: true });
      app.getAppPath = () => path.join(__dirname, 'app.asar');
    }
    app.on('browser-window-created', (_event, win) => { win.show = () => {}; });
    const fixture = fs.readFileSync(path.join(__dirname, 'fixture.flac'));
    const large = fs.readFileSync(path.join(__dirname, 'large.flac'));
    const audio = data => {
      let at = 4, last = false;
      while (!last) { last = !!(data[at] & 0x80); at += 4 + data.readUIntBE(at + 1, 3); }
      return data.subarray(at);
    };
    const visits = new Map();
    const activeDownloads = new Set();
    let sawPaused = false, sawResumed = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/http-429' || url.pathname === '/http-403') {
        const status = Number(url.pathname.slice(6));
        res.writeHead(status, { 'Content-Type': 'text/html', 'Retry-After': '2', 'Cache-Control': 'no-store' });
        res.end('Source response fixture'); return;
      }
      if (url.pathname === '/wrong.flac') {
        const wrong = fs.readFileSync(path.join(__dirname, 'wrong.flac'));
        res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Disposition': 'attachment; filename="wrong.flac"', 'Content-Length': wrong.length });
        res.end(wrong); return;
      }
      if (url.pathname === '/large.flac') {
        res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Disposition': 'attachment; filename="large.flac"', 'Content-Length': large.length });
        res.end(large); return;
      }
      if (url.pathname === '/fixture.flac') {
        res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Disposition': 'attachment; filename="song.flac"', 'Content-Length': fixture.length });
        let offset = 0;
        const timer = setInterval(() => {
          res.write(fixture.subarray(offset, offset + 512)); offset += 512;
          if (offset >= fixture.length) { clearInterval(timer); res.end(); }
        }, 10);
        res.on('close', () => clearInterval(timer));
        return;
      }
      const query = url.searchParams.get('query');
      const count = (visits.get(query) || 0) + 1; visits.set(query, count);
      res.setHeader('Content-Type', 'text/html');
      res.end(query === 'Retry' && count === 1
        ? '<div class="alert-error">Backend unavailable</div>'
        : query === 'Other' && count === 1 ? '<a class="download-button" href="/wrong.flac">Download</a>'
        : '<a class="download-button" href="' + (query === 'Large' ? '/large.flac' : '/fixture.flac') + '">Download</a>');
    });
    const deadline = setTimeout(() => { console.error('Electron smoke timed out'); app.exit(1); }, 45000);
    server.listen(0, '127.0.0.1', () => {
      require(${JSON.stringify(packaged ? './app.asar/main.js' : './main.js')});
      app.whenReady().then(async () => {
        try {
          const port = server.address().port;
          session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://lucida.to/*'] }, (details, callback) => {
            const url = new URL(details.url);
            callback({ redirectURL: 'http://127.0.0.1:' + port + '/release' + url.search });
          });
          session.defaultSession.on('will-download', (_event, item) => {
            activeDownloads.add(item);
            item.once('done', () => activeDownloads.delete(item));
          });
          ipcMain.on('downloads-pause', () => { if ([...activeDownloads].some(item => item.isPaused())) sawPaused = true; });
          ipcMain.on('downloads-resume', () => { if ([...activeDownloads].some(item => !item.isPaused())) sawResumed = true; });
          const win = BrowserWindow.getAllWindows()[0];
          await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
          // Wait for the real built React app to boot before mounting the test engine.
          const ui = await win.webContents.executeJavaScript(
            'new Promise((resolve, reject) => { const until = Date.now() + 10000; const tick = () => { if (document.querySelector(".app")) resolve(document.body.innerText); else if (Date.now() > until) reject(new Error(document.body.innerText)); else setTimeout(tick, 50); }; tick(); })'
          );
          if (!ui.includes('Downloads')) throw new Error('Built UI did not boot: ' + ui);
          const keepTryingSaved = await win.webContents.executeJavaScript(
            '(async () => { [...document.querySelectorAll(".nav-item")].find(button => button.textContent.includes("Settings")).click(); await new Promise(resolve => setTimeout(resolve, 50)); const label = [...document.querySelectorAll("label.switch")].find(label => label.textContent.includes("Keep trying")); if (!label) throw new Error("Keep trying option missing"); label.querySelector("input").click(); const config = await window.require("electron").ipcRenderer.invoke("get-config"); return config.keepTrying; })()'
          );
          if (!keepTryingSaved) throw new Error('Keep trying setting was not saved');
          await win.webContents.executeJavaScript('(' + ${JSON.stringify(probeSourceResponses.toString())} + ')(' + JSON.stringify('http://127.0.0.1:' + port) + ')');
          // Exercise label focus through trusted mouse input. input.click()
          // toggles the value without focusing the absolutely positioned input
          // and missed a document scroll that moved the entire UI off screen.
          for (let n = 0; n < 4; n++) {
            const point = await win.webContents.executeJavaScript(
              '(() => { const pane = document.querySelector(".main .pane"); pane.scrollTop = pane.scrollHeight; const label = [...document.querySelectorAll("label.switch")].find(el => el.textContent.includes("Play a sound")); const r = label.querySelector(".track").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()'
            );
            win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
            win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
            win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
            await new Promise(resolve => setTimeout(resolve, 75));
            const shell = await win.webContents.executeJavaScript(
              '({ scrollY, top: document.querySelector(".app").getBoundingClientRect().top, focused: document.activeElement?.type, checked: document.activeElement?.checked, sidebarBottom: document.querySelector(".sidebar").getBoundingClientRect().bottom })'
            );
            if (shell.focused !== 'checkbox' || shell.checked !== (n % 2 === 0)) throw new Error('Trusted sound click did not focus and toggle the checkbox: ' + JSON.stringify(shell));
            if (shell.scrollY !== 0 || shell.top !== 0 || shell.sidebarBottom <= 0) throw new Error('Sound label focus moved the app out of the window: ' + JSON.stringify(shell));
          }
          const soundsSaved = await win.webContents.executeJavaScript(${JSON.stringify('(' + checkSounds.toString() + ')()')});
          if (!soundsSaved) throw new Error('Sound setting was not saved');
          // A hidden window may return its previous compositor frame on the
          // first capture; request a frame, then capture the settled controls.
          await win.webContents.capturePage();
          await new Promise(resolve => setTimeout(resolve, 150));
          await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(__dirname, 'settings.png'), image.toPNG()));
          await win.webContents.executeJavaScript(${JSON.stringify('(' + checkCustomBackend.toString() + ')()')});
          await win.webContents.capturePage();
          await new Promise(resolve => setTimeout(resolve, 150));
          await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(__dirname, 'source-settings.png'), image.toPNG()));
          await win.webContents.executeJavaScript(${JSON.stringify('(' + checkLinkPreview.toString() + ')()')});
          await win.webContents.executeJavaScript(${JSON.stringify('(' + checkNavigation.toString() + ')(false)')});
          const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
          win.reload(); await reloaded;
          await win.webContents.executeJavaScript(
            'new Promise((resolve, reject) => { const until = Date.now() + 10000; const tick = () => { if (document.querySelector(".app")) resolve(); else if (Date.now() > until) reject(new Error("UI did not restart")); else setTimeout(tick, 50); }; tick(); })'
          );
          await win.webContents.executeJavaScript(${JSON.stringify('(' + checkNavigation.toString() + ')(true)')});
          await win.webContents.capturePage();
          await new Promise(resolve => setTimeout(resolve, 150));
          await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(__dirname, 'recent-profiles.png'), image.toPNG()));
          const { downloads: results, libraries } = await win.webContents.executeJavaScript(${JSON.stringify(renderer)});
          if (new Set(results.map(result => result.savePath)).size !== 3) throw new Error('Concurrent files collided');
          for (const result of results.slice(0, 2)) {
            if (!fs.readFileSync(result.savePath).equals(fixture)) throw new Error('Downloaded bytes changed');
            if (result.file !== path.basename(result.savePath)) throw new Error('Completion filename differs from actual save path');
          }
          const repaired = fs.readFileSync(results[2].savePath);
          if (!audio(repaired).equals(audio(large))) throw new Error('Artwork repair changed audio frames');
          if (repaired.length >= large.length || repaired.length !== results[2].bytes) throw new Error('Artwork size or saved byte count incorrect');
          let at = 4, picture = false, last = false;
          while (!last) {
            last = !!(repaired[at] & 0x80);
            const len = repaired.readUIntBE(at + 1, 3);
            if ((repaired[at] & 0x7f) === 6) { picture = true; if (len > 3 * 1024 * 1024) throw new Error('Artwork still oversized'); }
            at += 4 + len;
          }
          if (!picture) throw new Error('Artwork repair removed the cover');
          for (const [i, name] of ['Owner', 'Second'].entries()) {
            const dir = path.join(__dirname, 'downloads', name);
            const library = libraries[i];
            if (new Set(library.playlists.map(pl => pl.file.toLowerCase())).size !== library.playlists.length) throw new Error('Playlist filename collision');
            for (const track of Object.values(library.tracks)) {
              for (const file of new Set([track.file, ...Object.values(track.playlistFiles || {})])) {
                if (!fs.readFileSync(path.join(dir, file)).equals(fixture)) throw new Error('Shared track copy changed');
              }
            }
            for (const pl of library.playlists) {
              const art = fs.readFileSync(path.join(dir, pl.folder, 'cover.png'));
              if (art[0] !== 137 || art[1] !== 80 || nativeImage.createFromBuffer(art).isEmpty()) throw new Error('Playlist cover is not a valid PNG');
              for (const key of pl.trackKeys) {
                const file = library.tracks[key].playlistFiles[pl.folder];
                if (!file || !fs.existsSync(path.join(dir, file))) throw new Error('Missing playlist audio copy');
              }
            }
          }
          if ((visits.get('Retry') || 0) < 2) throw new Error('Failed track was not automatically retried');
          if ((visits.get('Other') || 0) < 2 || fs.existsSync(path.join(__dirname, 'downloads', 'wrong.flac'))) throw new Error('Wrong recording was accepted or retained');
          if (!sawPaused || !sawResumed) throw new Error('Pause/resume did not reach live Chromium transfers');
          const fixtureWindow = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
          await fixtureWindow.loadFile(path.join(__dirname, 'ui-fixture', 'index.html'));
          const uiRegression = await fixtureWindow.webContents.executeJavaScript(
            'new Promise((resolve, reject) => { const until = Date.now() + 10000; const tick = () => { if (window.runUIRegression) { try { resolve(window.runUIRegression()); } catch (error) { reject(error); } } else if (Date.now() > until) reject(new Error("UI fixture did not load")); else setTimeout(tick, 25); }; tick(); })'
          );
          if (!uiRegression.recovered || uiRegression.extraExpansions) throw new Error('UI regressions failed');
          fixtureWindow.destroy();
          console.log('PASS: React render recovery preserves queue; 80 progress ticks across 10001 rows caused no full-list rebuilds');
          console.log('PASS: real HTTP 429/Retry-After and 403 source observations; custom Monochrome backend validation, save and reset');
          console.log('PASS: download expansion and filter survive navigation and reload; filtered collapse preserves hidden choices; recent profiles reopen cached playlists without a search; restored source is Qobuz rather than Spotify metadata');
          console.log('PASS: ${packaged ? 'packaged archive' : 'source'}, built UI, trusted sound-label clicks keep the shell onscreen, sound toggle, bounded volume writes, audio device failures, invalid link preview, saved preferences, real cascades, automatic retry, wrong remix rejected, three FLAC downloads, actual filenames, byte integrity, oversized artwork retained, audio frames unchanged, shared profile copies, distinct playlist folders and PNG covers, live pause/resume, disposal and clean quit');
          clearTimeout(deadline); server.close(); app.quit();
        } catch (error) { console.error(error.stack); clearTimeout(deadline); server.close(); app.exit(1); }
      });
    });
  `;
  await fs.writeFile(path.join(sandbox, 'smoke.cjs'), bootstrap);
  await fs.writeFile(path.join(sandbox, 'package.json'), JSON.stringify({ name: `lucidafetcher-smoke-${process.pid}`, main: 'smoke.cjs' }));
  const output = await run(electron, [sandbox]);
  if (!output.includes('PASS:')) throw new Error(output || 'Smoke check exited before running');
  const manifest = JSON.parse(await fs.readFile(path.join(stateRoot, 'state', 'manifest.json'), 'utf8'));
  if (Object.keys(manifest).length !== 3) throw new Error('Quit did not flush all completed downloads to the manifest');
  const config = JSON.parse(await fs.readFile(path.join(stateRoot, 'state', 'config.json'), 'utf8'));
  if (config.keepTrying !== true) throw new Error('Keep trying preference did not survive quit');
  if (config.sounds !== true || config.soundVolume !== 0.7) throw new Error('Sound preferences did not survive quit');
  if (config.queueView?.filter !== 'missing' || config.queueView?.collapsed?.length !== 3) throw new Error('Download view preferences did not survive quit');
  console.log(output.split(/\r?\n/).filter(line => line.startsWith('PASS:')).join('\n'));
  // This directory is created above solely for this check; never remove a
  // computed path unless it is still inside that temporary workspace.
  if (path.dirname(path.resolve(sandbox)) !== path.resolve(os.tmpdir()) || !path.basename(sandbox).startsWith('lucidafetcher-smoke-')) throw new Error('Unexpected smoke workspace');
  if (process.argv.includes('--keep-artifacts')) console.log('Smoke artifacts retained at ' + sandbox);
  else await fs.rm(sandbox, { recursive: true, force: true });
} catch (error) {
  console.error(error.message);
  console.error('Smoke artifacts retained at ' + sandbox);
  process.exitCode = 1;
}
