# Working on Vesper

Vesper is a macOS personal AI operating layer: a WebGL orb, local voice, Codex/Claude/local model routing, coding-agent coordination, and an Obsidian-compatible memory vault.

**Start by reading `PROGRESS.md`.** It holds the checklist, decisions and next steps. Update it in the same commit as your work.

## Commands

```bash
npm install
npm run dev        # Electron app with hot reload
npm run check      # typecheck + unit tests + build (what CI runs)
npm run dist       # unsigned .dmg in dist/
```

The voice sidecar (`voice/server.py`) is started by the app through `uv run`; the first run downloads the Whisper and Kokoro models.

## Layout

| Path | What |
| --- | --- |
| `src/core/` | Pure, tested logic shared by main and renderer: types, stream parsers, router, reply parsing, task state, notes. |
| `src/main/` | Electron main: window modes and hotkeys (`index.ts`), conversation controller (`brain.ts`), providers, tasks, vault, projects, voice sidecar manager, settings. |
| `src/preload/` | The `window.bluevis` IPC bridge. |
| `src/renderer/` | React UI. `orb/` is the shader; `views/` are Talk, Agents, Memory, Settings. |
| `voice/` | Python MLX voice sidecar. |
| `vault-template/` | Generic public vault structure copied on first run. |
| `vault/` | The owner's personal vault. **Gitignored. Never commit it or paste its contents anywhere public.** |
| `test/` | Vitest suites; `test/fixtures/` holds real (scrubbed) Codex and Claude event streams. |

## Rules

- This repo is public. No personal data, vault content, tokens or local paths in commits.
- Status shown to the user must come from observed events. Never mark agent work verified without an observed passing check.
- No em dashes in user-facing copy.
- Keep the design system: tokens in `src/renderer/src/styles.css` (`--klein`, `--glacier`, serif for Vesper's voice, mono for evidence and data). Amber is reserved for decisions that need the user.
- Prefer small, verified changes; run `npm run check` before committing.
