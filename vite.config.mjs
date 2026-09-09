import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Electron loads the built UI over file://, so every asset URL has to be
// relative - an absolute /assets/... path resolves to the filesystem root and
// silently loads nothing.
export default defineConfig({
  root: 'src/ui',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    // Defence in depth, not the fix. The engine generates the scripts it injects
    // into scraped pages from its own functions via Function.prototype.toString(),
    // and minifying those bodies once renamed the identifiers they referred to -
    // breaking every search in the built app while dev and the tests, which are
    // unminified, stayed green. matching.mjs is now written so its injected
    // functions have no free identifiers and survive minification on their own;
    // this simply removes the whole class of failure, and on a local desktop app
    // the bundle size it costs is worth nothing.
    minify: false,
    // The engine is plain ESM already and is imported straight from src/engine,
    // so nothing special is needed for it here.
  },
  server: { port: 5173, strictPort: true },
});
