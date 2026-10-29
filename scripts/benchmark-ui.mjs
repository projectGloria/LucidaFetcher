import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const root = process.cwd(), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lucida-benchmark-'));
const require = createRequire(import.meta.url);
const baseline = execFileSync('git', ['show', 'HEAD:src/ui/views/QueueView.jsx'], { encoding: 'utf8', cwd: root });
await build({ configFile: false, base: './', logLevel: 'error', plugins: [react(), {
  name: 'baseline-queue',
  resolveId(source, importer) {
    if (source === 'baseline:queue') return '\0baseline-queue.jsx';
    if (importer === '\0baseline-queue.jsx' && source.startsWith('.')) return this.resolve(path.resolve(root, 'src/ui/views', source));
  },
  load(id) { if (id === '\0baseline-queue.jsx') return baseline; },
}], build: { outDir: directory, minify: false,
  rolldownOptions: { input: path.join(root, 'test/performance-fixture.jsx'), output: { entryFileNames: 'fixture.js', assetFileNames: '[name][extname]' } } } });
await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><link rel="stylesheet" href="./performance-fixture.css"><script type="module" src="./fixture.js"></script>');
await fs.writeFile(path.join(directory, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { backgroundThrottling: false, offscreen: true } });
  try {
    await win.loadFile(require('path').join(__dirname, 'index.html'));
    await win.webContents.executeJavaScript('new Promise((resolve, reject) => { const start = Date.now(); const timer = setInterval(() => { if (window.runQueueBenchmark) { clearInterval(timer); resolve(); } else if (Date.now()-start>10000) {clearInterval(timer); reject(new Error("Fixture did not load"));} }, 20); })');
    const results = [];
    for (const count of [500, 5000]) for (const layout of ['grouped', 'custom']) for (const baseline of [true, false]) {
      const cpuStart = process.cpuUsage();
      const result = await win.webContents.executeJavaScript('window.runQueueBenchmark(' + count + ',' + baseline + ',' + JSON.stringify(layout) + ')');
      result.mainCpuMicros = process.cpuUsage(cpuStart);
      result.processes = app.getAppMetrics().map(p => ({ type: p.type, cpuPercent: p.cpu.percentCPUUsage, workingSetKB: p.memory.workingSetSize }));
      results.push(result);
      if (!baseline && count === 5000 && layout === 'custom') {
        require('fs').writeFileSync(${JSON.stringify(path.join(root, 'review/queue-performance-2026-10-28.png'))}, (await win.webContents.capturePage()).toPNG());
      }
    }
    console.log('BENCHMARK:' + JSON.stringify(results)); app.exit(0);
  } catch (error) { console.error(error.stack); app.exit(1); }
});
setTimeout(() => { console.error('Benchmark deadline'); app.exit(1); }, 120000);
`);
const output = await new Promise((resolve, reject) => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [path.join(directory, 'main.cjs')], { windowsHide: true, env });
  let text = ''; child.stdout.on('data', b => { text += b; }); child.stderr.on('data', b => { text += b; });
  child.on('error', reject); child.on('exit', code => code ? reject(new Error(text)) : resolve(text));
});
const line = output.split(/\r?\n/).find(value => value.startsWith('BENCHMARK:'));
if (!line) throw new Error(output);
const results = JSON.parse(line.slice(10));
await fs.mkdir(path.join(root, 'review'), { recursive: true });
await fs.writeFile(path.join(root, 'review/performance-2026-10-28.json'), JSON.stringify({
  baseline: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  note: 'Original QueueView versus virtualized QueueView, same current engine and row components; controlled render benchmark, not network throughput.', results,
}, null, 2));
console.log(JSON.stringify(results.map(({ count, baseline: old, layout, mountMs, filterMs, rows, bottomRows }) => ({ count, baseline: old, layout, mountMs, filterMs, rows, bottomRows })), null, 2));
if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('lucida-benchmark-')) throw new Error('Unexpected benchmark path');
await fs.rm(directory, { recursive: true, force: true });
