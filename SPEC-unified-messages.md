# 仕様書: データの `_system` チャンネル統一

## 概要

`agents.json` / `channels.json` に分散していたエージェント設定・チャンネル設定を、
既存の `messages` テーブルに統一する。メモリー・サマリーも含め、全システムデータを
`_system` チャンネルに集約し、sync を `/api/sync` 1本に集約する。

## 動機

現状、データの保存先が分散しており、同期ロジックも複数存在する。

| データ | 現状の保存先 | 同期方法 |
|---|---|---|
| メッセージ | `chat.db` messages | `/api/sync`（append-only） |
| チャンネル基本情報 | `chat.db` channels テーブル | `/api/sync` に含まれる |
| チャンネルメタ（status等） | `channels.json` | 別途 `/api/channels/meta` |
| エージェント設定 | `agents.json` | 別途 `/api/agents` |
| メモリー | `chat.db` messages / `_memory` チャンネル | `/api/sync`（append-only） |
| サマリー | `chat.db` messages / `_summary` チャンネル | `/api/sync`（append-only） |
| タスク | `chat.db` messages (metadata) | `/api/sync`（append-only） |

**問題点:**
- チャンネル情報が DB と JSON ファイルの2箇所に存在する
- `sync.ts` にファイル同期の専用コードがある（`/api/channels/meta`, `/api/agents` の取得・書き出し）
- `server.ts` にファイル読み書き用の API エンドポイントが複数ある
- P2P同期のある設計で JSON ファイルは衝突リスクがある
- メモリー・サマリーが `_memory` / `_summary` という専用チャンネルに分散しているが、metadata キーで種別を識別しているためチャンネル分離は冗長
- `/api/channels` と `/api/channels/meta` が分かれており、チャンネル情報の取得が2つのAPIに分散
- `ChatConfig.agents` に古いレガシーフィールドが残っている（`config.json` → `agents.json` のマイグレーションコード）

## 設計方針

1. **全システムデータを `_system` チャンネルに集約する** — metadata の JSON キーで種別を識別。設定・メモリー・サマリー・タスクすべて `_system` に統一
2. **append-only** — 設定変更も「イベント」として追記。最新の状態は name ごとに最新メッセージから構築
3. **`config.json` のみファイルとして残す** — ノード固有のサーバー設定（port, upstream 等）は同期不要
4. **設定メッセージに `reply_to` は使わない** — name ベースのグループ化で最新を解決する。タスク更新と異なり、元メッセージ ID の追跡は不要
5. **設定メッセージは毎回スナップショット全体を含む** — 差分パッチではなく、全フィールドを毎回送る
6. **`/api/channels` と `/api/channels/meta` を統合** — チャンネル情報は1つの API で返す
7. **レガシーコードの一掃** — `ChatConfig.agents` フィールド、`AgentInfo` 型など古いマイグレーションパスを廃止

## データモデル

### `_system` チャンネル

全システムデータ（設定変更・メモリー・サマリー）は `channel = "_system"` に投稿する。
通常のチャンネル一覧（`chat channels`）には表示しない。

`openDb()` のスキーマ初期化で `_system` チャンネルを作成する（FK 制約を満たすため）:
```sql
INSERT OR IGNORE INTO channels (name) VALUES ('_system');
```

**`_system` に集約される metadata キー:**
- `$.agent_config` — エージェント登録・変更・削除
- `$.channel_config` — チャンネル設定・変更
- `$.memory` — エージェントメモリー
- `$.summary` — チャンネルサマリー
- `$.task` / `$.task_update` — タスク

これにより `_memory` / `_summary` 専用チャンネルは廃止。

### エージェント設定 — `$.agent_config`

エージェントの登録・変更を表現する。

```json
{
  "id": "m1abc_xyz",
  "channel": "_system",
  "author": "kensaku",
  "content": "Register agent: Opus",
  "metadata": {
    "agent_config": {
      "name": "Opus",
      "role": "builder",
      "description": "コアシステムを構築するエンジニア",
      "channels": ["general", "dev", "review"]
    }
  }
}
```

設定変更（`reply_to` なし、同じ `name` で新しいメッセージを投稿するだけ）:

```json
{
  "id": "m2def_abc",
  "channel": "_system",
  "author": "kensaku",
  "content": "Update agent: Opus — add review channel",
  "metadata": {
    "agent_config": {
      "name": "Opus",
      "role": "builder",
      "description": "コアシステムを構築するエンジニア",
      "channels": ["general", "dev", "review"]
    }
  }
}
```

エージェント削除:

```json
{
  "id": "m3ghi_def",
  "channel": "_system",
  "author": "kensaku",
  "content": "Remove agent: Opus",
  "metadata": {
    "agent_config": {
      "name": "Opus",
      "removed": true
    }
  }
}
```

**最新の設定の取得方法:**
1. `agent_config` を持つメッセージを `name` ごとにグループ化
2. 各 name について最新のメッセージ（最大 ID）を取得
3. `removed: true` のものを除外

### チャンネル設定 — `$.channel_config`

チャンネルの作成・設定変更を表現する。

```json
{
  "id": "m4jkl_ghi",
  "channel": "_system",
  "author": "kensaku",
  "content": "Create channel: general",
  "metadata": {
    "channel_config": {
      "name": "general",
      "description": "全体チャンネル",
      "status": "active"
    }
  }
}
```

チャンネル設定の変更:

```json
{
  "id": "m5mno_jkl",
  "channel": "_system",
  "author": "kensaku",
  "content": "Update channel: general — paused",
  "metadata": {
    "channel_config": {
      "name": "general",
      "description": "全体チャンネル",
      "status": "paused"
    }
  }
}
```

**最新の設定の取得方法:**
1. `channel_config` を持つメッセージを `name` ごとにグループ化
2. 各 name について最新のメッセージ（最大 ID）を取得
3. channels テーブルに存在するが channel_config メッセージがないチャンネルは、デフォルト status="active" として扱う

### メモリー / サマリー — `_system` チャンネルに統合

既存の `$.memory`, `$.summary` metadata パターンはそのまま維持するが、
投稿先チャンネルを `_memory` / `_summary` から `_system` に変更する。

クエリは metadata キー（`json_extract(metadata, '$.memory')` 等）で種別を識別しており、
チャンネルに依存していないため、チャンネル変更による影響はない。

**廃止するチャンネル:**
- `_memory` — メモリーは `_system` に投稿
- `_summary` — サマリーは `_system` に投稿

## 変更箇所

### `src/db.ts`

**`openDb()` の変更:**
- スキーマ初期化後に `_system` チャンネルを作成

**追加する関数:**

```typescript
interface AgentConfigData {
  name: string;
  role: string;
  description: string;
  channels: string[];
}

function getAgentConfigs(db: Database): Record<string, AgentConfigData>
// → agent_config を持つメッセージを走査し、name ごとに最新を返す
//   removed: true は除外

interface ChannelConfigData {
  name: string;
  description: string;
  status: "active" | "paused" | "archived";
}

function getChannelConfigs(db: Database): Record<string, ChannelConfigData>
// → channel_config を持つメッセージを走査し、name ごとに最新を返す
//   channels テーブルのみに存在するチャンネルはデフォルト値で補完
```

**channels テーブルから description カラムを削除:**
- source of truth は `channel_config` メッセージに移行
- `description` は FK 制約に不要なため、カラム自体を削除してスキーマを簡素化
- スキーマ: `CREATE TABLE channels (name TEXT PRIMARY KEY, created_at TEXT)`
- `createChannel()` の引数から `description` を外す
- `getChannels()` が返す description は `getChannelConfigs()` から取得するように変更

### `src/config.ts`

**廃止する関数:**
- `readChannelsMeta()` / `writeChannelsMeta()`
- `readAgentsConfig()` / `writeAgentsConfig()`

**廃止する型:**
- `AgentInfo` — レガシー型（`ChatConfig.agents` 用）
- `ChannelMeta`, `ChannelsConfig`
- `AgentConfig`, `AgentsConfig`

**`ChatConfig` から削除するフィールド:**
- `agents?: AgentInfo[]` — `config.json` → `agents.json` のレガシーマイグレーションパス。DB移行で不要になる

**残すもの:**
- `ChatConfig`, `readConfig()`, `writeConfig()` — ノード固有設定
- sync cursor 関連（`readSyncCursor()`, `writeSyncCursor()` 等）

### `src/server.ts`

**完全に廃止する API:**
- `GET /api/channels/meta` — `/api/channels` に統合
- `POST /api/channels/meta` — `/api/channels` に統合

**書き換える API（ファイル操作 → DB 操作）:**
- `GET /api/agents` — `readAgentsConfig()` → `getAgentConfigs(db)` に置き換え
- `POST /api/agents` — `writeAgentsConfig()` → `_system` チャンネルにメッセージ投稿
- `DELETE /api/agents/:name` — `writeAgentsConfig()` → `_system` チャンネルに removed メッセージ投稿

**変更する API:**
- `GET /api/channels` — channels テーブル + `getChannelConfigs(db)` をマージして返す。`_system` チャンネルは除外。レスポンスに `status` フィールドを含める:
  ```json
  { "channels": [{ "name": "general", "description": "全体", "status": "active", "created_at": "..." }] }
  ```
- `POST /api/channels` — channels テーブルへの INSERT に加え、`_system` に `channel_config` メッセージを自動生成。status 更新もこの API で受け付ける:
  ```json
  // チャンネル作成: { "name": "dev", "description": "開発用" }
  // 設定変更:       { "name": "dev", "status": "paused" }
  ```
- `GET /api/context` — レスポンスから `channels` / `agents` を削除（`/api/channels`, `/api/agents` と重複するため）。CHAT.md の `content` のみ返す

**WebSocket ブロードキャスト:**
- `POST /api/agents`, `DELETE /api/agents/:name` で `_system` メッセージ投稿後、`{ type: "agents", agents }` イベントをブロードキャスト
- `POST /api/channels` での設定変更時、`{ type: "channels", channels }` イベントをブロードキャスト

**廃止する WebSocket イベント:**
- `channels_meta` → `channels` に統合（`channels` イベントが status を含む）
- `channel` → `channels` に統合（チャンネル作成も `channels` イベントで全チャンネルリストを送る）

変更後のイベント体系: `msg`, `agents`, `channels`, `members`, `ack`, `error` の6種類

**`GET /api/sync` の変更:**
- `_system` メッセージも通常メッセージとして含まれるため追加対応不要

### `src/sync.ts`

**削除するコード:**
```typescript
// この部分を丸ごと削除（L52-66）
// Sync channels.json and agents.json from upstream
try {
  const [chRes, agRes] = await Promise.all([
    fetch(`${url}/api/channels/meta`, { ... }),
    fetch(`${url}/api/agents`, { ... }),
  ]);
  ...
} catch {}
```

sync は `/api/sync` のメッセージ取得だけで完結する。

### `cli.ts`

**`chat init`:**
- `writeChannelsMeta()` / `writeAgentsConfig()` の呼び出しを削除
- 代わりに `openDb()` 後に `_system` チャンネルへ channel_config メッセージを投稿

**`chat agent create`:**
- オーナー: `writeAgentsConfig()` → `_system` チャンネルへの `sendToUpstream()` に変更
- メンバー: `POST /api/agents` → サーバー側で `_system` メッセージ投稿

**`chat agent list`:**
- `readAgentsConfig()` / `fetch /api/agents` → `getAgentConfigs(db)` / `fetch /api/agents`
  （API のレスポンスが DB ベースに変わるだけで、CLI 側の変更は最小限）

**`chat agent remove`:**
- `writeAgentsConfig()` → `_system` チャンネルへの removed メッセージ投稿

**`chat channels`:**
- `/api/channels/meta` の別途取得を廃止。`/api/channels` が status を含むため、1回の fetch で完結
- オーナー: `readChannelsMeta()` → `getChannelConfigs(db)` に置き換え
- `ChannelsConfig` 型のインポートを削除

**`chat channel:create`:**
- オーナー: `createChannel(db)` + `_system` チャンネルに channel_config メッセージを投稿
- メンバー: `POST /api/channels`（サーバー側で channel_config メッセージを自動生成）

**`chat context`:**
- `/api/channels/meta` / `readChannelsMeta()` → `/api/channels` / `getChannelConfigs(db)` に置き換え
- `/api/agents` / `readAgentsConfig()` → `/api/agents` / `getAgentConfigs(db)` に置き換え

**`chat memory add`:**
- 投稿先チャンネルを `_memory` → `_system` に変更

**`chat summary create`:**
- 投稿先チャンネルを `_summary` → `_system` に変更

### `web/index.html`

- フッター `Files: .chat/channels.json, .chat/agents.json` を削除
- `fetchChannelsMeta()` 関数を廃止。`fetchChannels()` が status を含むため不要に
- `state.channelsMeta` を廃止。チャンネル情報は `state.channels` に統合（各チャンネルオブジェクトが `status` フィールドを持つ）
- `renderChannels()` のメタ参照を `state.channels[i].status` に変更
- `init()` の `await fetchChannelsMeta()` を削除
- WebSocket `channels_meta` イベントを廃止。`channels` イベントで status 含むチャンネル一覧を受け取る
- WebSocket `channel` イベントを廃止。`channels` イベントに統合
- Context パネルの channels/agents データ取得を `/api/channels`, `/api/agents` から取得するように変更（`/api/context` は CHAT.md のみ返す）

## 廃止するファイル・チャンネル

| 対象 | 種別 | 理由 |
|---|---|---|
| `.chat/agents.json` | ファイル | DB `_system` チャンネルに移行 |
| `.chat/channels.json` | ファイル | DB `_system` チャンネルに移行 |
| `_memory` | チャンネル | `_system` チャンネルに統合 |
| `_summary` | チャンネル | `_system` チャンネルに統合 |

## マイグレーション

`openDb()` の中で実行。既存データを DB に移行する。

```
1. config.json に agents フィールドが存在する場合（レガシー）:
   a. 各エージェントの設定を _system チャンネルにメッセージとして投稿
      author は config.json の identity を使用
   b. config.json から agents フィールドを削除して書き戻し

2. agents.json が存在する場合:
   a. 各エージェントの設定を _system チャンネルにメッセージとして投稿
      author は config.json の identity を使用
   b. agents.json を agents.json.bak にリネーム

3. channels.json が存在する場合:
   a. 各チャンネルの設定を _system チャンネルにメッセージとして投稿
      author は config.json の identity を使用
   b. channels.json を channels.json.bak にリネーム

4. channels テーブルに存在するが channel_config メッセージがないチャンネル:
   a. デフォルトの channel_config メッセージを生成（status="active"）

5. _memory / _summary チャンネルの既存メッセージ:
   a. channel フィールドを _system に更新
      UPDATE messages SET channel = '_system' WHERE channel IN ('_memory', '_summary');
   b. _memory / _summary チャンネルを channels テーブルから削除

6. channels テーブルの description カラム削除:
   SQLite は ALTER TABLE DROP COLUMN 未サポートのため、テーブル再作成で対応:
   a. CREATE TABLE channels_new (name TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')));
   b. INSERT INTO channels_new (name, created_at) SELECT name, created_at FROM channels;
   c. DROP TABLE channels;
   d. ALTER TABLE channels_new RENAME TO channels;
```

マイグレーションは冪等に実装する（`.bak` が存在すれば再実行しない。UPDATE は冪等）。

## sync フロー（変更後）

```
メンバー                          オーナー
  |                                  |
  |  GET /api/sync?since=<cursor>    |
  |--------------------------------->|
  |                                  |  messages テーブルから取得
  |                                  |  （_system チャンネル含む全メッセージ）
  |  { messages, channels, cursor }  |
  |<---------------------------------|
  |                                  |
  |  INSERT OR IGNORE into messages  |
  |  INSERT OR IGNORE into channels  |
  |                                  |
  |  ★ agents.json, channels.json   |
  |    の別途取得は不要             |
```

## `.chat/` ディレクトリ構成（変更後）

```
.chat/
  config.json      ← ノード固有のサーバー設定（同期しない。唯一のファイル直接編集対象）
  chat.db          ← 全データ（メッセージ、設定、メモリー、サマリー、タスク）
  chat.db-shm      ← SQLite WAL
  chat.db-wal      ← SQLite WAL
  .sync            ← sync カーソル
  .read_cursor     ← 既読カーソル
```

## 設計原則との整合

| 原則 | 変更後の整合性 |
|---|---|
| Append-only messages | ✅ 設定変更もメッセージとして追記 |
| 同期は /api/sync で完結 | ✅ ファイル別途同期を廃止 |
| Source of truth は1つ | ✅ chat.db のみ |
| config.json はノード固有 | ✅ 変更なし |
| CLI or direct file edits | ⚠️ 共有データは CLI 経由のみに変更。ファイル直接編集は config.json のみ |

## CLAUDE.md の更新

```markdown
## Architecture

  cli.ts            CLI entry point, all commands
  src/server.ts     HTTP/WebSocket server (Bun.serve), standby/tunnel
  src/db.ts         SQLite schema, queries, all data operations
  src/config.ts     Node-local config (.chat/config.json)
  src/sync.ts       Upstream sync (message-based, single endpoint)
  web/index.html    Read-only monitoring UI (single file)

Data lives in `.chat/` dir: `config.json` (node-local), `chat.db` (all shared data).

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
```
