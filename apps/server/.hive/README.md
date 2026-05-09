# HIVE 2.0 — Sovereign Multi-Agent Orchestration System

This directory is managed automatically by the HIVE 2.0 plugin.

## Structure

```
.hive/
├── config.json         — Configuration (edit this)
├── session/            — Session state (auto-managed)
│   ├── state.json      — Current state
│   └── history/        — Historical snapshots
├── events/             — Telemetry (JSONL)
├── evidence/           — Agent task outputs
├── plans/              — Implementation plans
├── knowledge/          — Hivemind semantic memory
├── context/            — Session context
├── checkpoints/        — State checkpoints
└── logs/               — Internal logs
```

## Commands

- `/hive status` — Current phase and task
- `/hive plan` — Full project plan
- `/hive history` — What has been completed
- `/hive reset` — Start over
- `/hive handoff` — Preserve context before context fills
- `/hive diagnose` — Check HIVE health

## Do not edit files in session/ or events/ manually.
