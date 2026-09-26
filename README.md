# Vesper

A personal AI operating layer for macOS. A living orb of Klein-blue ink that listens, speaks with a local British voice, coordinates Codex and Claude as coding agents, and keeps what matters in an Obsidian-compatible vault you own.

- **Talk** by voice (⌥⇧Space) or text. Replies are spoken locally with Kokoro; speech-to-text is Whisper on MLX. No paid speech services.
- **Delegate**: "have Codex fix the failing test in Yonder". Agents run sandboxed in the project, and their status comes from what they actually did. Work is only marked *verified* when a passing check was observed after the last edit.
- **Remember**: preferences, decisions and ideas become Markdown notes, each change a commit you can review and undo.
- **Look**: ⌥⇧L sends a screenshot with your question, only when you ask.
- **Models**: Codex (GPT-6 Luna for conversation, Sol/Astra for agents), Claude (Haiku/Sonnet/Opus), or a local OpenAI-compatible server such as Splash (`splash serve`, port 8000), which runs Qwen3.6-35B-A3B at ~200 tok/s on an M5 Pro.

## Requirements

Apple Silicon Mac, Node 22+, [`uv`](https://docs.astral.sh/uv/), and the `codex` (>= 0.157) and/or `claude` CLIs signed in.

```bash
npm install
npm run dev
```

See `PROGRESS.md` for status and roadmap, and `AGENTS.md` for how the code is organized.
