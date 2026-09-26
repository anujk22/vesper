# Vesper progress

Single source of truth for build status. **Any agent picking this up: read this file first, then `AGENTS.md`.** Update it in the same commit as the work it describes.

Last updated: 2026-09-25 03:00 ET by Claude Opus (Claude Code session)

## Current state

v0.1 core loop is built and runs: orb, text chat through Codex/Claude/local, local voice, agent delegation with honest status, vault memory with undo. See "Next up" for what to do next.

## Decisions (with reasons)

| Decision | Why |
| --- | --- |
| Electron + React + raw WebGL2 shader, no UI/3D libraries | Floating always-on-top orb, global hotkeys and easy CLI process control; the orb is one fragment shader, so three.js would be dead weight. |
| Drive the `codex`, `claude` CLIs instead of APIs | Uses the owner's ChatGPT Pro / Claude subscriptions with no API keys, and their JSON event streams give real, observable agent status. |
| Conversation default: Codex `gpt-6-luna`, low effort (~4s round trip) | Fast enough for voice. Agents default to `gpt-6-sol` medium. Claude Haiku/Opus and a local server (Splash on :8000 by default, thinking off for conversation) are switchable (Settings, or say "switch to Claude"). Requires Codex CLI >= 0.157. |
| Deterministic intent router before any model (`src/core/router.ts`) | "have Codex…", "open X", "status", "stop", "remember…" never need a model (PRD §15.8). Jev/Laya "Reflex" deliberately skipped for v1. |
| Brain is read-only; real work is delegated | The brain proposes `ACTION:` lines that render as an approval card. Agents run sandboxed (`codex -s workspace-write`, Claude `acceptEdits` + sandbox). |
| Task "verified" only if a passing test/build/typecheck is observed after the last edit | PRD's core honesty rule. Everything else is "done · unverified". Logic in `src/core/taskState.ts`. |
| Vault = plain Markdown folder + its own local git repo | Obsidian-compatible, user-owned, and every memory write is a commit, so "what changed" and undo are free. |
| Vault lives at `./vault` in dev and is **gitignored**; this repo is public | Personal knowledge never goes to GitHub. `vault-template/` is the generic, public starting structure. |
| `share: local-only` notes are never sent to cloud models | Work notes are local-only, and the internship folder is not scanned. |
| Local voice: Whisper large-v3-turbo + Kokoro (`bm_george`) on MLX via a `uv` Python sidecar | No paid TTS. STT ~0.2s warm. First run downloads ~2GB of models. |
| Screen only on demand (⌥⇧L or the eye button) | No continuous observation (PRD §9). |

## How memory reaches a model (retrieval)

Nothing loads the whole vault. Per turn Vesper sends: `Profile/Core.md` (~1.3k chars, always), the active project's note, and the top ~6 passages from hybrid search, capped at ~7k chars (~2k tokens). Notes are split at headings into passages (`src/core/retrieval.ts`), scored with BM25 (titles + Obsidian `aliases` weighted) and fused (reciprocal rank) with local bge-small embeddings from the sidecar (`/embed`, fastembed on CPU, cached in userData/embeddings.json). Without the sidecar it falls back to keywords only. `Sources/` and `index: false` notes are never retrieved; `share: local-only` passages only go to local models. Each reply shows the passages it was given, and Memory has a search box that runs the same retrieval.

## Checklist

### Phase 1: foundation (done)
- [x] Repo, Electron + Vite + React + TS, CI (typecheck, tests, build on macOS; tagged releases build an unsigned `.dmg`)
- [x] Provider layer: Codex / Claude / OpenAI-compatible local, normalized event stream (`src/core/parsers.ts`, tested against real captured streams)
- [x] Intent router, reply parser (spoken vs shown, `ACTION:`/`MEMORY:` directives), task state reducer, note/frontmatter utils, all unit tested
- [x] Vault service: template, git history, scoped retrieval, memory writes, sessions, agent-run outputs, revert
- [x] Seed vault from PRD §4 (all `needs-review`), local only
- [x] Voice sidecar (`voice/server.py`) and renderer mic/VAD + pipelined TTS

### Phase 2: experience (done, iterating)
- [x] Orb shader: IKB ink in glass, state looks, audio-driven edge, one satellite per running agent
- [x] Talk view: empty-state greeting, serif "voice" typography, proposals, memory lines with undo, inline live task cards
- [x] Agents view: observed steps, files changed, diff stat, verification explanation, stop
- [x] Memory view: areas, status legend, note cards, reader, "what changed" timeline with revert
- [x] Settings: models, provider health, voice, vault, project folders, shortcuts, privacy summary
- [x] Compact orb mode (⌥Space), talk hotkey (⌥⇧Space), look hotkey (⌥⇧L)

### Phase 3: verify end to end (in progress)
- [x] Live chat round trip with Codex Luna in the app (~5s), reply rendered and spoken via Kokoro
- [x] Delegation round trip: Codex Sol fixed a failing test in a scratch repo; observed fail → edit → pass, marked verified
- [ ] Voice input round trip in the app (TTS output verified; mic permission prompt needs the owner at the machine)
- [ ] Screen capture (Screen Recording permission needs the owner)
- [ ] Packaged `.dmg` smoke test

- [x] Decision → `Decisions/` note, "I'm done" → `Sessions/` note, "where did I leave off" → grounded resume
- [x] Voice sidecar recovers if it dies (restart + honest message)

### Phase 4: knowledge (done)
- [x] Personal knowledge export split into 53 notes (Profile, Education, Career, Projects, Tools, Interests, Work, Private, People), text preserved, citations kept, private sections `local-only`, raw export kept in `Sources/Raw` (not retrieved)
- [x] Hybrid retrieval (BM25 + embeddings + aliases), sources shown on replies, Memory search
- [x] Sidecar versioning: a stale sidecar from before an update is replaced, not adopted

### Phase 5: integrations and polish (done)
- [x] Hackathon relay (Devpost → Opus ideate → Astra challenge → Opus consolidate), live pipeline view, plan saved to `Outputs/Hackathons/` (verified end to end on HackNYU 2025, ~9 min)
- [x] Read-only Gmail through Claude's Gmail connector (write tools explicitly denied), every search shown under the reply
- [x] Calendar + Canvas via private ICS feeds (Settings → Calendars), recurrences, time zones
- [x] Usage remaining for Codex (session logs) and Claude (rate-limit events) in the header (beside the wordmark), model menu and Settings; Claude takes one tiny Haiku reading at launch when its last reading is over 3h old
- [x] Pocket TTS voices + one-click voice picker with previews; Kokoro kept as the fast option
- [x] Glass redesign (navy fog, pearl orb, glass header/cards/composer), native traffic lights, menu bar icon, orb app icon
- [x] Installable app: `npx electron-builder --mac dir` then copy `dist/mac-arm64/Vesper.app` to /Applications
- [ ] GPT image generation as an MCP tool for Claude (Codex image_generation works from exec, ~60s/image)
- [x] Local brain on Splash (`brew install incoai/tap/splash`, model `incoai/Qwen3.6-35B-A3B-Splash`, ~21 GB): Vesper starts `splash serve` when conversation uses a Splash model and nothing answers at the local URL, and stops it on quit. Conversation sends `reasoning_effort: none` so the first word is not delayed by thinking; screenshots go as image parts. Gemini provider removed (no way to use a Google AI Pro subscription without an API key)
- [x] Accent color in Settings: presets plus any hue; stylesheet blues are OKLCH-rotated by `--dh`/`--c` (`src/core/color.ts` does the same for the orb). Neutrals and amber never shift
- [x] More expressive Kokoro voices in the picker (Bella, Isabella, Nova, Puck, Fenrir)
- [x] History: Codex (app, CLI) and Claude Code threads listed from `~/.codex/sessions` + `session_index.jsonl` and `~/.claude/projects`; readable in Vesper and continuable (runs as a tracked agent task resuming the same session id). Unverified: whether the Codex app shows a continuation made this way
- [x] Canvas: Rutgers blocks student tokens, so the default is "Sign in to Canvas" (Anuj signs in via NetID in a Vesper window, `persist:canvas` partition; reads use that session and strip the `while(1);` prefix). Token path kept as a fallback. Keychain token + base URL; planner items with submission state, current grades, last-week announcements feed the agenda intent. Bad tokens rejected on save (verified against Rutgers). Unverified with a real sign-in
- [x] Work tab (replaces Agents): login-shell terminals via node-pty + xterm (persist across views, split panes), agents list beside them. Vesper reads the terminal last typed in when a question is about output/errors (plain text, credentials redacted, last 150 lines; agents only if same project). Take over an agent run, or open any History thread, as `codex resume` / `claude --resume` in a terminal. Verified: terminal error explained by Claude Haiku from the terminal tail
- [x] Hackathon mode (Hackathon tab, relays now persisted in `relays.json`): "Lock in" on a finished relay has Sonnet extract deadline, timed checkpoints, judging criteria and hook (`hackathons.json`); dashboard with countdown, timeline, behind/next, criteria coverage; scaffold repo (`~/Documents/Coding/Hackathons/<slug>`, PLAN.md + AGENTS.md, never overwrites); one agent per checkpoint on its own branch + git worktree; submission kit (write-up, 90s script, checklist) grounded in commits, saved to vault. While active: red accent override, heartbeat orb that quickens over the last 12h, header countdown chip (amber when behind), brain knows the schedule. Verified e2e in a test profile except agents-per-checkpoint (Codex auth was down)
- [x] Whisper vocabulary hint (sidecar v4)
- [x] Attention nudge when ≥20% of the weekly Codex allowance resets within 12h, and when a hackathon checkpoint is overdue. (The overnight queue was cut: never verified, and the control tower will cover work while away)
- [ ] Google Calendar live via the claude.ai connector (waiting for Anuj to enable it; then read tool names and wire like Gmail)
- [ ] Lecture and team-meeting mode (local transcription to vault notes)
- [ ] Capture anywhere hotkey
- [ ] One search across vault, History, Canvas and email subjects
- [x] Daily brief ("brief me", "good morning", Talk card; optional once-per-morning auto brief): calendar (today/tomorrow), Canvas, agents finished since last brief, hackathon line; fetched in parallel, spoken under 45s. Recruiting digest cut (slow, not wanted)
- [x] Streaming speech: sentences are spoken as the reply streams (Claude, local); Codex still speaks after completion
- [x] Memory gate: general questions get a one-line identity only; the vault is consulted for personal, schedule, work and project questions, with strict meaning-gated retrieval (thresholds measured on the real vault)
- [x] Graphite glass theme, centered nav, Codex remaining meter in the header

### Phase 6: next up
- [x] Link vault project notes to repos by `path:` (Yonder → `Hackathons/Shopify`, observed from its git remote)
- [x] ChatGPT export importer (Memory → Teach and review): active-branch parsing, batched extraction with Codex `--output-schema`, review queue with keep/edit/discard, ledger in `vault/.bluevis/imports.json` so re-imports skip processed threads and never resurrect discarded items
- [x] "In your own words" dump → proposals through the same pipeline (voice input for it still to do)
- [x] Review queue for imported proposals
- [ ] Review flow for the seeded `needs-review` notes (confirm / correct in place)
- [x] Chat history: every Talk conversation saves to `chats/<id>.json` (debounced, flushed on switch); Recent menu and New chat above the transcript, recent pills on the empty screen; reopening a chat continues it (local history, Codex/Claude session ids). A reply stopped by switching chats never lands in the next one
- [x] Narration modes (composer speaker button cycles Brief, Full, Mute; also in Settings): brief reads short replies whole (60 words or less) and the opening of long ones; full reads everything including detail
- [x] Header model menu shows only the models picked in Settings (`pickerModels`); thinking gear beside it; Qwen defaults to low thinking
- [x] Memory across chats: with a local brain, every message gets vault context (no personal-question gate) plus up to three matching exchanges from other chats in the last 14 days (`ChatStore.recall`, local embeddings, same 0.63 bar as vault). Verified: a detail from one chat answered in a fresh one. Known: the model sometimes saves near-duplicate notes
- [x] Visible thinking: local reasoning streams into a live "Thinking" block that folds to "Thought for Ns" (Codex reasoning summaries too)
- [x] Web research, free and keyless ("research …"): the model plans 2 to 4 queries, each runs on Exa's and Parallel's public MCP search at once (DuckDuckGo, then Bing, as fallback; 5 min cache), the top 4 pages are read in full (Exa fetch, Parallel fallback), and the answer streams with [n] citations, a sources row and every search shown. ~30s end to end. "search …" opens Google in the browser. Only queries leave the Mac
- [x] "Hey Vesper" (Settings, off by default): one always-open mic stream cut into utterances by an adaptive energy gate; only the first 2.2s of each is transcribed locally to look for the wake word, the whole utterance only when it is there. "Vesper, transcribe …" types into the focused app; "Vesper" alone waits for a command. Whisper hears "Vesper" reliably across voices (tested with synthesized speech; live mic not yet verified)
- [x] Dictation shortcut (default ⌥⇧D, configurable): record until a 2s pause, local Whisper, Qwen cleanup (punctuation, filler, "scratch that") for anything over five words, pasted via the clipboard (restored after). Needs Accessibility permission
- [x] Mac commands ("open X and Y" instantly; "split Claude and Vesper", "put X on the left" planned by Qwen as open/quit/place/url/search actions; not a Mac action falls back to chat). Window placement needs Accessibility permission; verified up to that prompt
- [x] Renamed Bluevis to Vesper (product name, app id `dev.anujk.vesper`, wordmark, persona, docs). On first launch the old `Application Support/Bluevis` folder moves to `Application Support/Vesper`. Internal identifiers that saved data depends on keep the old name (`window.bluevis`, the `bluevis` speaker tag, `BLUEVIS_*` env vars, the vault's `.bluevis` folder)
- [x] Reply layout: thinking, searches, sources and vault notes are one row of pills that fold open (grid-row animation); the live panel stays open until answer text arrives, then folds; the answer is always last
- [x] Thinking slider in the composer (right of attach): drag a dot from Off to Low, Medium, High, Ultra; wheel and arrow keys too
- [x] Ultra agent teams ("launch 3 agents who …", or the model's SWARM directive in Ultra): Qwen plans nicknames, personas and debate or parallel mode; every agent is a concurrent request to Splash, researches on the web when it matters, then responds to the others by name for 2 to 3 rounds; the main chat writes the verdict. UI: a roster of recolored Vesper orbs above one shared timeline grouped by round; click an orb to follow one agent, @Name in the main composer talks to it. Saved with the chat. Verified end to end (3 agents, 3 rounds, verdict, a direct question)
- [x] Power: on battery the local model unloads at once and loads only when asked (unloads again after 10 idle minutes); plugged in it stays loaded. Switching Splash models swaps the server
- [x] Idle memory upkeep (plugged in, Mac idle 10 min, no thermal pressure, Vesper not busy, at most every 30 min): refresh embeddings, then merge one group of near-duplicate auto-captured Inbox notes (cosine 0.86) with high thinking, as one undoable commit. Verified with shortened timers: three HackRU notes became one
- [x] Default local model: Qwen3.8 27B (dense). Measured on the M5 Pro alone: 60 to 115 tok/s on short replies and thinking, 32 to 35 tok/s on long prose, ~400 tok/s prefill (vs A3B's 95 / ~2,600); it needs far fewer thinking tokens, so reasoning answers arrive sooner. A3B stays one click away
- [x] Listening pill: a focus-free, click-through, always-on-top window at the bottom of the screen under the pointer, with live bars from the mic level and a timer while listening or dictating, "Transcribing" while Whisper runs, then what was heard for 1.8s. "Hey Vesper" is now on by default whenever Vesper runs
- [x] Anuj's messages are right-aligned bubbles; replies show tok/s (estimated per delta while streaming, exact from Splash's usage report at the end)
- [x] Pill redesign (React page): a live mini orb (same shader, current accent) reacting to the mic or Vesper's voice, a glowing mirrored waveform, a turning light ring while live, then what was heard. When Vesper talks while its window is hidden, the pill shows the talking orb. Spoken questions open Vesper; quick actions (open, search, transcribe, Mac commands) do not
- [x] One Vesper at a time: a single-instance lock (per profile, so test profiles still run beside it); launching again brings the running window forward. The pill has a small close button on its left while listening or talking: it throws away what was being heard, or stops speech. The pill still lets clicks through everywhere else
- [x] Dock: Vesper stays a regular Dock app. `setVisibleOnAllWorkspaces` turned the process into a UI element (no Dock icon); both calls now pass `skipTransformProcessType`
- [x] Brighter app icon (high contrast orb with rim light) so it reads in the macOS 26 Clear and tinted Dock styles
- [ ] Control tower (next): watch every Codex and Claude Code session (Claude Code hooks + Codex `notify`, session files as fallback); flag waiting-for-you, repeated failures, stalls and two sessions editing one file; local model writes one-line summaries and decides whether to interrupt; per-project "where was I" notes feeding the brief
- [ ] Menu bar presence and launch at login
- [ ] Active-app context (frontmost app + window title) with explicit permission
- [ ] Wake word (openWakeWord) as an opt-in
- [ ] Gmail / Calendar as scoped skills (read-only first)
- [ ] Custom voice identity experiment (Pocket TTS / Qwen3-TTS cloning with a rights-cleared reference)

## Known issues / notes for the next agent
- `codex exec` emits feature notices as `error` items; they are mapped to warnings, not failures.
- Codex brain turns cost ~50k (mostly cached) input tokens each because of Codex's own system prompt.
- Project names are folder names unless a vault project note sets `path:`.
- Run `npm run check` before committing. UI changes: take a screenshot of the real app (Playwright `_electron` works).
- **Testing against the real vault is forbidden.** Launch with `BLUEVIS_PROFILE_DIR=/some/tmp/dir` to get isolated settings and a fresh vault.
- An unexplained mic activation was seen once during automated testing and did not reproduce; watch for it.
