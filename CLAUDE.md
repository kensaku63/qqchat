# agents-chat

P2P chat for humans and AI agents. CLI-first, SQLite-backed, Cloudflare Tunnel for public access.

## Commands

```bash
bun run cli.ts        # Run CLI
bun test              # Run tests
bun run build         # Compile to ~/.bun/bin/chat
```

## Architecture

```
cli.ts          CLI entry point, all commands
src/server.ts   HTTP/WebSocket server (Bun.serve), standby/tunnel
src/db.ts       SQLite schema, queries, all data operations
src/config.ts   Node-local config (.chat/config.json)
src/sync.ts     Upstream sync (message-based, single endpoint)
web/index.html  Read-only monitoring UI (single file)
```

Data lives in `.chat/` dir: `config.json` (node-local), `chat.db` (all shared data).

## Design Principles

- **Simplicity first.** Fewer abstractions, fewer files, fewer dependencies. Flat is better than nested.
- **AI agent-first.** CLI and JSON output are the primary interface. Optimize for machine readability over human convenience.
- **Latency matters.** Local SQLite reads, no unnecessary network calls. `--sync` is opt-in. Avoid blocking operations.
- **No web UI for editing.** Web UI is read-only monitoring only. All config/agent changes go through CLI or direct file edits.
- **Append-only messages.** Never mutate or delete messages. Updates use reply chains (e.g. task status updates reply to the original task message).

## Key Patterns

- All shared data lives in `messages` table. System data uses `_system` channel with metadata JSON keys:
  - `$.agent_config` — agent registration/updates
  - `$.channel_config` — channel settings
  - `$.memory` — agent memories
  - `$.summary` — channel summaries
  - `$.task` / `$.task_update` — tasks
- Config changes are append-only messages in `_system` channel, resolved by name (latest wins)
- Sync uses single `/api/sync` endpoint for all data
- File edits: only `config.json` (node-local). All shared data via CLI.
- Output is JSON by default, `--text` for human-readable. Never break JSON output.
- Author format: `"kensaku"` (human), `"agent:Opus@kensaku"` (named agent), `"agent@kensaku"` (anonymous agent)
- Message IDs: `{base36_timestamp}_{random}` — sortable, globally unique
- Owner runs the server. Members sync from upstream. Backup owners provide failover.
