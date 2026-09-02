# Repository Guidelines

## Project Structure & Module Organization

LucidaFetcher is a small CommonJS Electron application with three primary files:

- `main.js` runs the Electron main process. It owns windows, IPC handlers, downloads, filesystem access, persistent state, and logging.
- `renderer.js` contains UI behavior, metadata scraping, Lucida webview automation, matching, and queue orchestration.
- `index.html` defines the three-tab interface, inline styles, and hidden automation webviews.

Runtime data lives under `state/` (`config.json`, queue, manifest, and cache), while `logs/` contains per-session JSONL diagnostics. Treat both as generated user data, not source or test fixtures. See `CLAUDE.md` for detailed architecture and selector notes.

## Build, Test, and Development Commands

- `npm ci` installs the lockfile-pinned Electron dependency.
- `npm start` launches the app locally with `electron .`.
- `node --check main.js` validates main-process JavaScript syntax.
- `node --check renderer.js` validates renderer syntax outside injected template-literal scripts.
- `Get-ChildItem logs` inspects captured sessions when debugging automation or downloads.

There is no packaging/build step, linter, or automated test suite. `npm test` is currently a failing npm placeholder and is not a validation command.

## Coding Style & Naming Conventions

Match the existing JavaScript: two-space indentation, semicolons, single quotes, `const`/`let`, camelCase functions and variables, and `UPPER_SNAKE_CASE` constants. Keep IPC channel names descriptive and kebab-cased, such as `download-progress`. Preserve the main/renderer ownership boundary: disk and download work belongs in `main.js`; UI and orchestration belong in `renderer.js`.

Injected `executeJavaScript` bodies require special care. Escape backslashes twice (for example, `\\s`) and never assume `node --check` parses their generated code.

## Testing Guidelines

Run both syntax checks after every JavaScript change, then exercise affected flows with `npm start`. For matcher changes, extract the injected scorer into a temporary Node harness and cover remix/version mismatches, shared-surname artist mismatches, and folded letters (`ł`, `ø`, `æ`, `ß`). Keep probes and DOM dumps outside the repository and review the newest JSONL log for silent selector failures.

## Commit & Pull Request Guidelines

This checkout has no Git history, so no repository-specific commit convention can be inferred. Use short imperative subjects (for example, `Fix stalled fallback retry`) and keep commits focused. Pull requests should explain the user-visible behavior, list manual checks, link relevant issues, and include screenshots for UI changes. Call out Lucida/Spotify selector changes and attach sanitized log excerpts when they support the diagnosis; never include download paths, cookies, cached metadata, or other user data.
