import { execFileSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { Controller } from '../src/engine/controller.mjs';
import { attachPersistence } from '../src/engine/renderer-integration.mjs';

const source = execFileSync('git', ['show', 'HEAD:src/engine/controller.mjs'], { encoding: 'utf8' })
  .replace(/from '(\.\/[^']+)'/g, (_match, relative) => `from '${new URL('../src/engine/' + relative.slice(2), import.meta.url).href}'`);
const { Controller: Baseline } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const originalIntegration = execFileSync('git', ['show', 'HEAD:src/engine/renderer-integration.mjs'], { encoding: 'utf8' })
  .replace(/from '(\.\/[^']+)'/g, (_match, relative) => `from '${new URL('../src/engine/' + relative.slice(2), import.meta.url).href}'`);
const { attachPersistence: baselinePersistence } = await import('data:text/javascript;base64,' + Buffer.from(originalIntegration).toString('base64'));
const results = [];
for (const count of [500, 5000]) for (const [name, Constructor] of [['baseline', Baseline], ['current', Controller]]) {
  globalThis.gc?.();
  const initialMemory = process.memoryUsage(), cpuStart = process.cpuUsage();
  const items = Array.from({ length: count }, (_, index) => ({ id: `bench-${index}`, title: `Track ${index}`, artist: 'Fixture', status: 'queued', searchVariants: [`Track ${index}`] }));
  const json = JSON.stringify({ v: 4, paused: true, items, profiles: [], playlists: [], tracks: [] });
  let firstMs, started;
  const controller = new Constructor({ concurrency: 3, services: ['qobuz'], getWorker: () => ({ run: async () => {
    await new Promise(resolve => setTimeout(resolve, 1));
    if (firstMs == null) firstMs = performance.now() - started;
    return { outcome: 'completed' };
  } }) });
  const dispose = (name === 'baseline' ? baselinePersistence : attachPersistence)(controller, { on() {}, removeListener() {}, send() {},
    invoke: async channel => channel === 'queue-load' ? JSON.parse(json) : [] });
  const restoreStart = performance.now(); await controller.restore();
  const restoreMs = performance.now() - restoreStart;
  started = performance.now(); controller.resume(); await controller.pool.onIdle();
  const completionMs = performance.now() - started;
  if (controller.stats.completed !== count) throw new Error('Fixture queue did not complete');
  dispose(); controller.dispose();
  results.push({ count, version: name, restoreMs, firstCompletionMs: firstMs, completionMs,
    cpuMicros: process.cpuUsage(cpuStart), initialMemory, finalMemory: process.memoryUsage() });
}
await mkdir('review', { recursive: true });
await writeFile('review/engine-performance-2026-10-28.json', JSON.stringify({
  note: 'Same machine; HEAD controller versus current controller with current shared dependencies. In-memory IPC restore; three workers with a 1 ms fixture delay. This does not measure live provider or disk/network throughput.', results,
}, null, 2));
console.log(JSON.stringify(results.map(({ count, version, restoreMs, firstCompletionMs, completionMs }) => ({ count, version, restoreMs, firstCompletionMs, completionMs })), null, 2));
