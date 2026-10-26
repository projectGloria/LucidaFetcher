# Repository Guidelines

## Project Structure & Module Organization

LucidaFetcher is a Windows-first Electron application with a React interface.
- `main.js`: CommonJS main process; owns filesystem access, downloads, persistence, IPC, and tray integration.
- `src/engine/`: ESM download orchestration, matching, resolvers, and scraper cascades. Keep core logic independent of React and Electron; use `electron-bridge.mjs` for integration.
- `src/ui/`: React components, views, styles, and browser mock controller.
- `test/`: Node regression tests and UI fixtures. `scripts/` contains smoke checks and icon generators.
- `assets/`, `src/ui/assets/`, and `build/`: service artwork and application icons. `dist/` and `release/` contain generated builds.

## Build, Test, and Development Commands

- `npm ci`: install dependencies from the lockfile.
- `npm run dev:ui`: preview the UI with mock data at `http://localhost:5173`.
- `npm run build:ui` then `npm start`: build the renderer and launch Electron.
- `npm test`: run `test/*.test.mjs` using Node's test runner.
- `node --test test/pool.test.mjs`: run one test file.
- `npm run lint`: run ESLint correctness checks.
- `npm run test:electron`: build and run isolated Electron integration fixtures; requires `ffmpeg` on PATH.
- `npm run pack` then `npm run test:packaged`: create and smoke-test the unpacked application.
- `npm run dist:win` / `npm run dist:portable`: create Windows releases.

## Coding Style & Naming Conventions

Follow surrounding code: two-space indentation, single-quoted JavaScript strings, and semicolons. Use PascalCase for React components, camelCase for functions and variables, and descriptive module filenames. Preserve CommonJS in `main.js` and ESM in engine modules. ESLint is configured in `eslint.config.mjs`; no formatter is configured. Explain non-obvious failure modes in comments.

## Testing Guidelines

Use `node:test` and `node:assert/strict`; name files `*.test.mjs` and describe behavior in test titles. Add regression cases for changed behavior using injected transports, clocks, and controlled fixtures. Run tests and lint before submitting; run Electron checks for integration changes. No numeric coverage threshold is configured. Fixture success does not verify live provider markup.

## Commit & Pull Request Guidelines

History mixes descriptive messages, a `chore:` prefix, and terse legacy entries; no consistent convention is established. Prefer concise, imperative summaries. PRs should explain behavior changes, link relevant issues, list validation results, and include screenshots for UI changes.

## Architecture & Data Safeguards

Keep injected scraper functions self-contained. Preserve Vite's relative base and disabled minification. Update `package.json`'s packaging allowlist when adding main-process engine dependencies. Never commit live `state/` or `logs/`. Consult `CLAUDE.md` and `RELIABILITY.md` before changing persistence or retry behavior.
