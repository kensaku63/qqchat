# QQchat

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
web/index.html  Web UI (single file, monitoring + lightweight editing)
```

Data lives in `.chat/` dir: `config.json` (node-local), `chat.db` (all shared data).

## Design Principles

- **Simplicity first.** Fewer abstractions, fewer files, fewer dependencies. Flat is better than nested.
- **AI agent-first.** CLI and JSON output are the primary interface. Optimize for machine readability over human convenience.
- **Errors over fallbacks.** AI agents can handle errors. Never silently fall back or guess intent — return clear error messages so agents can correct and retry.
- **Latency matters.** Local SQLite reads, no unnecessary network calls. `--sync` is opt-in. Avoid blocking operations.
- **CLI is primary, Web UI is secondary.** CLI and direct file edits are the canonical interface. Web UI provides monitoring and lightweight editing (send messages, manage agents/tasks/channels). `public_read` mode makes Web UI read-only for external viewers.
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

## Unread Management

Per-reader unread tracking. Each reader (human or agent) has an independent read cursor.

- **Storage**: `.chat/.read_cursors.json` — `{ "kensaku": "<msg_id>", "directore": "<msg_id>", ... }`
- **CLI**: `chat unread <reader>` — reader name is **required** (positional arg). No default/fallback.
- **Validation**: reader must be a known identity. Unknown names → error, not fallback.
  - Agent: exists in `getAgentConfigs()` → subscribed channels (`agent_config.channels`) + `@name` mentions from all channels
  - Human: exists in `members` table with `type='human'` → all channels (`_system` excluded)
  - Neither → `Error: Unknown reader "<name>". Register as agent (chat agent create) or member first.`
- **Cursor isolation**: `chat unread directore` only advances directore's cursor. Other readers unaffected.
- **Agent onboarding**: new agent reads subscribed channels via `chat read`, saves key info to memory. First `chat unread <agent>` sets initial cursor position.
