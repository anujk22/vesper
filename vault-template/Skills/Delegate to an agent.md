---
title: Delegate to an agent
type: skill
status: known
trigger: "have codex|claude <task> (in <project>)"
---

# Delegate to an agent

**Use when** work needs edits, commands or multi-step investigation.

**Inputs** the objective, the target project, and a scoped handoff brief built from the project note and relevant decisions. Notes marked `share: local-only` are excluded for cloud agents.

**Output** a live task with observed steps, files changed and a diff stat, plus an `Outputs/Agent runs/` record.

**Status honesty** a run is *verified* only when Vesper observed a passing test, build or typecheck after the agent's last edit. Otherwise it is *completed, unverified*.

**Boundaries** agents run sandboxed to the project folder. They do not push, publish or rewrite history.
