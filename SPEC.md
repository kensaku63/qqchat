# agents-chat 仕様書

## 概要

ローカルディレクトリだけで完結するP2P型チャットシステム。
チームメンバーの一人が「Owner」としてデータをホストし、他メンバーがHTTP経由で高速同期する。
AIエージェント（Claude Code等）がファイルを直接読み書きできることを最優先に設計する。

## コンセプト

- **ディレクトリ = チャットルーム**: `chat init` するだけでチャットが生まれる
- **Owner-hosted P2P**: Ownerが軽量HTTPサーバーを立て、メンバーが接続する
- **AI-first データ形式**: JSONL（AI直読み用）+ SQLite（検索用）の二重構造
- **ゼロ依存**: アカウント登録不要、外部サービス不要、Bunだけで動く

## アーキテクチャ

```
┌──────────────────────────────────┐
│  Owner (host)                    │
│  .chat/                          │
│  ├── chat.db  ← 信頼の源        │
│  └── channels/*.jsonl            │
│                                  │
│  $ chat serve                    │
│    → http://localhost:4321       │
│    → https://xx.tunnel.dev (公開)│
└────────┬──────────┬──────────────┘
         │ HTTP      │ HTTP
    ┌────▼───┐  ┌───▼────┐
    │ Member │  │ Member │
    │ SQLite │  │ SQLite │
    │ +JSONL │  │ +JSONL │
    │ +Agent │  │ +Agent │
    └────────┘  └────────┘
```

## ディレクトリ構造

```
project/
└── .chat/
    ├── config.json              # ロール・接続情報・チャンネル設定
    ├── chat.db                  # SQLite（検索・集計用）
    ├── channels/
    │   ├── general.jsonl        # AI直読み用メッセージログ
    │   ├── dev.jsonl
    │   └── random.jsonl
    └── .sync                    # 最終同期タイムスタンプ
```

## データ形式

### メッセージ (JSONL)

1行1JSON。追記のみ（append-only）。AIエージェントが `cat` や `Read` で直接読める。

```jsonl
{"id":"msg_20260307_001","ts":"2026-03-07T10:30:00.000Z","channel":"dev","author":"kensaku","author_type":"human","content":"認証機能の設計方針を決めたい"}
{"id":"msg_20260307_002","ts":"2026-03-07T10:32:00.000Z","channel":"dev","author":"claude@kensaku","author_type":"agent","content":"現在のコードベースを確認しました。JWT + Supabase Authが最も適合します。","agent_context":{"model":"claude-opus-4-6","tool":"claude-code"}}
{"id":"msg_20260307_003","ts":"2026-03-07T10:35:00.000Z","channel":"dev","author":"tanaka","author_type":"human","content":"OAuthも対応したいです","reply_to":"msg_20260307_001"}
```

#### メッセージフィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` | string | Yes | `msg_{YYYYMMDD}_{連番 or nanoid}` |
| `ts` | string | Yes | ISO 8601 タイムスタンプ (UTC) |
| `channel` | string | Yes | チャンネル名 |
| `author` | string | Yes | 人間: `kensaku`, エージェント: `claude@kensaku` |
| `author_type` | string | Yes | `"human"` or `"agent"` |
| `content` | string | Yes | メッセージ本文（Markdown可） |
| `reply_to` | string | No | スレッド返信先のメッセージID |
| `agent_context` | object | No | `{ model, tool }` エージェントのメタ情報 |
| `mentions` | string[] | No | メンション対象 `["kensaku", "all"]` |

### SQLite スキーマ

```sql
CREATE TABLE channels (
    name TEXT PRIMARY KEY,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    author TEXT NOT NULL,
    author_type TEXT NOT NULL CHECK(author_type IN ('human', 'agent')),
    content TEXT NOT NULL,
    reply_to TEXT,
    agent_context TEXT,  -- JSON文字列
    mentions TEXT,       -- JSON配列文字列
    ts TEXT NOT NULL,
    FOREIGN KEY (channel) REFERENCES channels(name)
);

CREATE INDEX idx_messages_channel_ts ON messages(channel, ts);
CREATE INDEX idx_messages_author ON messages(author);
CREATE INDEX idx_messages_reply_to ON messages(reply_to);
```

### config.json

Owner側:
```json
{
  "role": "owner",
  "identity": "kensaku",
  "server": {
    "port": 4321
  },
  "channels": ["general", "dev", "random"],
  "members": [
    { "name": "kensaku", "joined": "2026-03-07T00:00:00Z" },
    { "name": "tanaka", "joined": "2026-03-07T00:00:00Z" }
  ]
}
```

Member側:
```json
{
  "role": "member",
  "identity": "tanaka",
  "upstream": "http://192.168.1.10:4321",
  "channels": ["general", "dev", "random"]
}
```

## CLI コマンド

実行ファイル: `chat`（`bun` で実行される CLI）

### `chat init [name]`

カレントディレクトリ（または指定名のサブディレクトリ）に `.chat/` を作成する。
- `config.json` を生成（role: owner）
- `chat.db` を初期化（テーブル作成）
- `channels/general.jsonl` を作成
- identityの入力を求める

```
$ chat init
? Your name: kensaku
Created .chat/ with channel #general
```

### `chat serve`

Owner専用。HTTPサーバーを起動してメンバーからの接続を受け付ける。

```
$ chat serve
Listening on http://localhost:4321
```

オプション:
- `--port <number>` ポート番号（デフォルト: 4321）
- `--tunnel` Cloudflare Quick Tunnel等でインターネット公開

### `chat join <url>`

指定URLのOwnerサーバーに接続し、ローカルにreplicaを構築する。

```
$ chat join http://192.168.1.10:4321
? Your name: tanaka
Syncing... done (42 messages)
Joined as tanaka
```

- `.chat/` を作成（role: member）
- 全メッセージを初回同期
- `config.json` に upstream URL を保存

### `chat send <channel> <message>`

メッセージを送信する。送信前に自動で同期する。

```
$ chat send dev "認証方式はJWTでいこう"
[dev] kensaku: 認証方式はJWTでいこう
```

オプション:
- `--as-agent` エージェントとして送信（author_type: agent）
- `--reply-to <message_id>` スレッド返信
- `--mention <name>` メンション追加

### `chat read <channel>`

チャンネルのメッセージを表示する。表示前に自動で同期する。

```
$ chat read dev
$ chat read dev --last 20
$ chat read dev --since 1h
$ chat read dev --search "認証"
$ chat read dev --unread
$ chat read dev --author claude@kensaku
$ chat read dev --threads          # スレッドをツリー表示
```

オプション:
- `--last <n>` 最新n件
- `--since <duration>` 指定時間以内（1h, 30m, 2d等）
- `--search <query>` 本文検索（SQLiteのLIKE）
- `--unread` 未読メッセージのみ
- `--author <name>` 特定authorのみ
- `--threads` スレッド返信をインデントして表示
- `--json` JSON形式で出力（AIエージェント向け）

### `chat sync`

手動で同期を実行する。

```
$ chat sync
Synced 5 new messages
```

### `chat channels`

チャンネル一覧を表示する。

```
$ chat channels
#general  - General discussion (42 messages)
#dev      - Development (128 messages)
#random   - Random (15 messages)
```

### `chat channel create <name> [description]`

新しいチャンネルを作成する（Owner専用、またはメンバーがリクエスト→Ownerに反映）。

### `chat status`

接続状態・同期状態を表示する。

```
$ chat status
Role: member
Upstream: http://192.168.1.10:4321 (connected)
Last sync: 2026-03-07T10:30:00Z (5 minutes ago)
Channels: 3
Messages: 185 (local) / 185 (remote)
```

## HTTP API（Owner サーバー）

Ownerが `chat serve` で公開するエンドポイント。最小限の3+α。

### `GET /sync?since=<iso_timestamp>`

指定タイムスタンプ以降の全チャンネルの新着メッセージを返す。

**Response:**
```json
{
  "messages": [
    {"id":"msg_001","ts":"...","channel":"dev","author":"kensaku","author_type":"human","content":"..."}
  ],
  "channels": ["general","dev","random"],
  "server_ts": "2026-03-07T10:35:00.000Z"
}
```

### `POST /messages`

メッセージを投稿する。

**Request:**
```json
{
  "channel": "dev",
  "author": "tanaka",
  "author_type": "human",
  "content": "OAuthも対応したいです",
  "reply_to": "msg_001"
}
```

**Response:**
```json
{
  "id": "msg_20260307_003",
  "ts": "2026-03-07T10:35:00.000Z"
}
```

### `GET /channels`

チャンネル一覧を返す。

**Response:**
```json
{
  "channels": [
    {"name": "general", "description": "General discussion", "created_at": "..."},
    {"name": "dev", "description": "Development", "created_at": "..."}
  ]
}
```

### `POST /channels`

チャンネルを作成する（Owner側のDBに反映）。

**Request:**
```json
{
  "name": "design",
  "description": "Design discussion"
}
```

## 同期フロー

### 送信フロー（Member）

```
1. GET /sync?since=最終同期時刻  → 新着を取得
2. 新着をローカル SQLite に INSERT + JSONL に append
3. POST /messages でメッセージ送信
4. 返却された id/ts でローカル SQLite + JSONL に記録
5. .sync タイムスタンプを更新
```

### 受信フロー（sync / read 時）

```
1. GET /sync?since=最終同期時刻
2. 新着をローカル SQLite に UPSERT
3. 新着をチャンネル別 JSONL に append
4. .sync タイムスタンプを更新
```

### Owner側の送信

Ownerはローカル SQLite に直接 INSERT + JSONL append するのみ（自分がサーバー）。

### 同期タイミング

| タイミング | 動作 |
|---|---|
| `chat send` 実行時 | 送信前に自動 pull |
| `chat read` 実行時 | 表示前に自動 pull |
| `chat sync` 実行時 | 明示的な pull |
| Claude Code SessionStart hook | 自動 pull（推奨設定） |

## AIエージェント連携

### 直接ファイル読み取り

AIエージェントは `.chat/channels/*.jsonl` を直接読める。

```bash
# Claude CodeのRead toolで直接読める
cat .chat/channels/dev.jsonl | tail -20

# SQLiteでも検索可能
sqlite3 .chat/chat.db "SELECT * FROM messages WHERE content LIKE '%認証%' ORDER BY ts"
```

### CLIからの投稿

```bash
chat send dev "調査結果です。JWTベースの認証が最適です。" --as-agent
```

### Claude Code Hook連携（推奨）

SessionStart hook で自動同期:
```json
{
  "hooks": {
    "SessionStart": [{
      "type": "command",
      "command": "chat sync 2>/dev/null || true"
    }]
  }
}
```

## 公開方法

| レベル | 方法 | 用途 |
|---|---|---|
| LAN内 | `chat serve` → `http://192.168.x.x:4321` | 同室チーム |
| インターネット | `chat serve --tunnel` → Cloudflare Quick Tunnel | リモートチーム |
| 永続公開 | VPS上で `chat serve` を常時起動 | OSSコミュニティ |

## 技術スタック

| 要素 | 選択 | 理由 |
|---|---|---|
| ランタイム | Bun | SQLite組み込み、高速、TypeScript直接実行 |
| DB | bun:sqlite | 外部依存なし、Bun組み込み |
| HTTPサーバー | Bun.serve() | 外部依存なし、高速 |
| ファイル操作 | Bun.file / Bun.write | ネイティブAPI |
| CLIフレームワーク | 自作（process.argv パース） | 外部依存最小化 |
| ID生成 | `crypto.randomUUID()` or nanoid | 衝突回避 |
| トンネル | cloudflared（オプション） | 無料、CLI完結 |

## 実装フェーズ

### Phase 1: コアCLI + ローカル動作
- `chat init` - 初期化
- `chat send` - ローカルDB + JSONL書き込み
- `chat read` - ローカル読み取り
- `chat channels` - チャンネル一覧
- SQLiteスキーマ + JSONL書き出し

### Phase 2: サーバー + 同期
- `chat serve` - HTTPサーバー起動
- `chat join` - リモート接続 + 初回同期
- `chat sync` - 差分同期
- 送信・読み取り時の自動同期

### Phase 3: 拡張機能
- `--tunnel` オプション（Cloudflare Quick Tunnel）
- `chat status` - 接続状態表示
- `--unread` 未読管理
- `--threads` スレッド表示
- メンション機能
- Claude Code Hook連携

### Phase 4: 将来拡張（未実装）
- メッセージ分割（月別 JSONL: `dev_2026-03.jsonl`）
- リアクション
- ファイル添付
- メッセージ編集・削除
- 暗号化通信
- Web UI（Bun.serve() HTML imports）

## 設計判断の根拠

| 判断 | 理由 |
|---|---|
| JSONL + SQLite 二重構造 | JSONL = AIが直接読める、SQLite = 高速検索。両方の利点を取る |
| HTTP同期（Git不使用） | Git push/pull は3-10秒。HTTP APIは0.05-0.1秒。桁違いに速い |
| Owner-hosted（中央サーバー不使用） | アカウント不要、無料、データ主権がOwnerにある |
| Bun単独（外部依存なし） | `bun install` 不要で動く世界を目指す。SQLite, HTTP, FS全てBun組み込み |
| append-only JSONL | 競合しにくい。AIエージェントは tail で最新を読むだけ |
