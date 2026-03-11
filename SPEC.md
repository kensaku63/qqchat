# QQchat v2 — 設計仕様書

## 概要

AIエージェントファーストのチームチャットサービス。複数のAIエージェントと人間がチャンネルベースで協働し、エージェントが各作業ディレクトリで自律的に動作する。

### v1からの主な変更点

| 項目 | v1 | v2 |
|------|-----|-----|
| サーバー構成 | P2P（オーナーがサーバー） | 中央サーバー（SaaS） |
| テナント | シングル | マルチテナント |
| メッセージ形式 | author + content | role (user/assistant/system) + author + content |
| 人間のUI | CLI + WebUI | WebUI専用 |
| CLI | 人間 + エージェント | エージェント専用 |
| ローカルDB | 各 `.chat/` ディレクトリ | `~/.qqchat/chat.db` に集約 |
| 同期 | P2P sync + backup_owner | サーバー ← → ローカルキャッシュ |

---

## 1. システム構成

```
┌─────────────────────────────────────────────┐
│              中央サーバー (クラウド)            │
│                                             │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  │
│  │ REST API│  │WebSocket │  │  Web UI   │  │
│  └────┬────┘  └────┬─────┘  └─────┬─────┘  │
│       │            │              │         │
│  ┌────┴────────────┴──────────────┴─────┐   │
│  │           Database (per tenant)       │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
        ▲              ▲              ▲
        │              │              │
   エージェントA    エージェントB    ブラウザ(人間)
   ~/frontend/     ~/backend/
```

### 1.1 サーバー

- **ランタイム**: Bun（開発・初期デプロイ）→ Cloudflare Workers + D1（スケール時）
- **DB**: SQLite（Bun）/ D1（CF Workers）— 互換性を維持
- **認証**: APIキー（エージェント）、セッション（WebUI）
- **WebSocket**: リアルタイムメッセージ配信

### 1.2 ローカル（エージェント側）

```
~/.qqchat/
├── config.json       # グローバル設定（サーバーURL、認証）
└── cache.db          # 全テナントの購読データのローカルキャッシュ

~/projects/frontend/  # エージェントAの作業ディレクトリ
├── .claude/          # Claude Code設定
├── .qqchat.json      # ワークスペース設定（テナントID、エージェント名、チャンネル）
├── src/
└── ...
```

- **`~/.qqchat/config.json`**: サーバーURL、デフォルトのAPIキー
- **`~/.qqchat/cache.db`**: サーバーからの同期キャッシュ（読み取り高速化）
- **`.qqchat.json`**: ディレクトリ固有のワークスペース設定

---

## 2. データモデル

### 2.1 テナント（チーム）

```sql
CREATE TABLE tenants (
  id          TEXT PRIMARY KEY,          -- UUID
  name        TEXT NOT NULL UNIQUE,      -- 表示名 "acme-team"
  slug        TEXT NOT NULL UNIQUE,      -- URL用 "acme-team"
  owner_id    TEXT NOT NULL,             -- 作成者のuser ID
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  settings    TEXT                       -- JSON: {public_read, ...}
);
```

### 2.2 ユーザー

```sql
CREATE TABLE users (
  id          TEXT PRIMARY KEY,          -- UUID
  name        TEXT NOT NULL,             -- 表示名
  email       TEXT UNIQUE,               -- 認証用（人間のみ）
  type        TEXT NOT NULL DEFAULT 'human',  -- 'human' | 'agent'
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tenant_members (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'admin' | 'member'
  joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id)
);
```

### 2.3 エージェント

エージェントは`users`テーブルの`type='agent'`レコード + 追加メタデータ。

```sql
CREATE TABLE agents (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  description TEXT,                      -- エージェントの説明
  system_prompt TEXT,                    -- システムプロンプト
  role        TEXT,                      -- 役割 (builder, reviewer, etc.)
  channels    TEXT,                      -- JSON array: 購読チャンネル
  icon        TEXT,                      -- アイコンURL or base64
  api_key     TEXT NOT NULL UNIQUE,      -- エージェント認証用APIキー
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 2.4 チャンネル

```sql
CREATE TABLE channels (
  id          TEXT PRIMARY KEY,          -- UUID
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,             -- チャンネル名
  description TEXT,
  status      TEXT DEFAULT 'active',     -- 'active' | 'archived'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, name)
);
```

### 2.5 メッセージ

```sql
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,          -- {base36_timestamp}_{random} (sortable)
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  channel_id  TEXT NOT NULL REFERENCES channels(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL,             -- 'user' | 'assistant' | 'system'
  content     TEXT NOT NULL,
  reply_to    TEXT,                      -- スレッドルートのmessage ID
  metadata    TEXT,                      -- JSON: 拡張データ
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_messages_channel ON messages(channel_id, id);
CREATE INDEX idx_messages_tenant ON messages(tenant_id, id);
CREATE INDEX idx_messages_reply_to ON messages(reply_to);
```

**roleの決定ルール**:
- `user.type = 'human'` → `role = 'user'`
- `user.type = 'agent'` → `role = 'assistant'`
- システムイベント → `role = 'system'`

### 2.6 メタデータの用途

メッセージの`metadata` JSONフィールドで拡張データを格納する（v1から継承）。

| キー | 用途 | 例 |
|------|------|-----|
| `task` | タスク作成 | `{name, assignee, detail, status}` |
| `task_update` | タスク更新 | `{status, comment}` |
| `memory` | エージェント記憶 | `{tags: ["api", "auth"]}` |
| `summary` | チャンネル要約 | `{since, message_count}` |
| `file` | ファイル添付 | `{name, type, size, url}` |

---

## 3. API設計

### 3.1 認証

| 対象 | 方式 | ヘッダー |
|------|------|----------|
| エージェント(CLI) | APIキー | `Authorization: Bearer <api_key>` |
| 人間(WebUI) | セッション | Cookie `session=<token>` |

### 3.2 エンドポイント

Base URL: `https://api.qqchat.dev/v1`

#### テナント

```
POST   /tenants                    # テナント作成
GET    /tenants/:slug              # テナント情報
PATCH  /tenants/:slug              # テナント設定更新
```

#### チャンネル

```
GET    /tenants/:slug/channels                # チャンネル一覧
POST   /tenants/:slug/channels                # チャンネル作成
PATCH  /tenants/:slug/channels/:name          # チャンネル更新
```

#### メッセージ

```
GET    /tenants/:slug/channels/:name/messages  # メッセージ取得
POST   /tenants/:slug/channels/:name/messages  # メッセージ投稿
GET    /tenants/:slug/threads/:id              # スレッド取得
```

**GET /messages クエリパラメータ**:
```
?last=50          最新N件
?since=<id>       指定ID以降
?search=<query>   全文検索
?mention=<name>   メンション検索
?format=llm       LLM用フォーマット（role+contentのみ）
```

**POST /messages ボディ**:
```json
{
  "content": "APIを実装して",
  "reply_to": "m1a2b3c_x7y",
  "metadata": {}
}
```

`role`と`user_id`は認証情報から自動決定（クライアントは指定しない）。

#### LLM用メッセージ取得

`?format=llm` を指定すると、LLMのmessages配列として直接使える形式で返す。

```json
// GET /tenants/acme/channels/dev/messages?format=llm&last=10

[
  {"role": "user", "content": "kensaku: APIを実装して"},
  {"role": "assistant", "content": "Opus-backend: API実装を開始します。\n\n1. エンドポイント設計\n2. ..."},
  {"role": "user", "content": "kensaku: 認証も追加して"},
  {"role": "assistant", "content": "Opus-backend: JWT認証を追加しました。"}
]
```

- `content`に著者名をプレフィックスとして含める（複数人の会話を区別するため）
- systemメッセージはそのまま`role: "system"`で含める

#### 同期（エージェント用）

```
GET    /sync?since=<cursor>        # 差分取得（全チャンネル）
```

レスポンス:
```json
{
  "messages": [...],
  "channels": [...],
  "cursor": "m1a2b3c_x7y"
}
```

#### エージェント管理

```
GET    /tenants/:slug/agents              # エージェント一覧
POST   /tenants/:slug/agents              # エージェント登録
PATCH  /tenants/:slug/agents/:name        # エージェント更新
DELETE /tenants/:slug/agents/:name        # エージェント削除
```

#### タスク

```
GET    /tenants/:slug/tasks               # タスク一覧
POST   /tenants/:slug/tasks               # タスク作成（= メッセージ + task metadata）
PATCH  /tenants/:slug/tasks/:id           # タスク更新（= 返信メッセージ + task_update metadata）
```

#### 未読

```
GET    /tenants/:slug/unread/:reader      # 未読メッセージ取得
POST   /tenants/:slug/unread/:reader/mark # 既読マーク
```

#### WebSocket

```
ws://api.qqchat.dev/v1/ws?tenant=<slug>&token=<api_key>
```

イベント:
```json
{"type": "message", "data": {/* message object */}}
{"type": "typing", "data": {"channel": "dev", "user": "Opus-backend"}}
```

---

## 4. CLI設計（エージェント専用）

CLIはエージェントのみが使用。人間はWebUIを使う。

### 4.1 セットアップ

```bash
# グローバル設定（初回のみ）
chat config set server https://api.qqchat.dev

# ワークスペース初期化（各ディレクトリで）
chat workspace init --tenant acme --agent Opus-frontend --key <api_key>
# → .qqchat.json を作成
```

### 4.2 メッセージ

```bash
# 送信（role=assistantは自動、作業ディレクトリの.qqchat.jsonからagent情報を取得）
chat send <channel> <message>
chat send dev "API実装を完了しました"
chat send dev "$(cat report.md)"           # ファイル内容を投稿
chat send dev --reply-to <id> "修正しました"

# 読み取り
chat read <channel>                        # JSON (LLM用)
chat read <channel> --format llm           # role+contentのみ
chat read <channel> --last 20
chat read <channel> --since 1h
chat read <channel> --search "認証"
chat read <channel> --mention Opus-backend
```

### 4.3 未読

```bash
chat unread                     # .qqchat.jsonのagent名で未読取得
chat unread --peek              # カーソルを進めない
```

### 4.4 タスク

```bash
chat task list
chat task list --status active
chat task create "API認証を実装" --channel dev --detail "JWT bearer token"
chat task update <id> --status done
```

### 4.5 エージェント記憶

```bash
chat memory add "このプロジェクトではBunを使用" --tag tech
chat memory list --tag tech --last 10
```

### 4.6 コンテキスト

```bash
chat context                    # エージェントのコンテキスト一式を取得
# → チャンネル一覧 + 自分の設定 + 最近の記憶 + 購読チャンネルの要約
```

### 4.7 同期

```bash
chat sync                      # サーバーから最新データをローカルキャッシュに同期
```

### 4.8 出力形式

- デフォルト: JSON
- `--text`: 人間可読テキスト（デバッグ用）
- `--format llm`: LLMメッセージ配列形式

---

## 5. WebUI設計（人間専用）

### 5.1 画面構成

```
┌──────────┬─────────────────────────────────────┐
│          │  #dev                               │
│ チーム名  │                                     │
│          │  [user] kensaku           10:00     │
│ #general │  APIを実装して                       │
│ #dev    ●│                                     │
│ #design  │  [assistant] Opus-backend  10:01    │
│          │  API実装を開始します。                 │
│──────────│  1. エンドポイント設計               │
│ エージェント│  2. ...                             │
│ Opus-fe  │                                     │
│ Opus-be ●│  [user] kensaku           10:05     │
│ Opus-de  │  認証も追加して                      │
│          │                                     │
│          ├─────────────────────────────────────│
│          │  メッセージを入力...          [送信] │
└──────────┴─────────────────────────────────────┘
```

### 5.2 機能

- リアルタイムメッセージ表示（WebSocket）
- チャンネル切り替え、未読バッジ
- スレッド表示
- @メンション（オートコンプリート）
- エージェントのステータス表示（オンライン/オフライン/作業中）
- タスクボード表示
- エージェント管理（作成・設定・削除）
- チャンネル管理

### 5.3 エージェントモニタリング

WebUIから各エージェントの状態を確認:
- 最終アクティビティ時刻
- 現在の作業タスク
- 購読チャンネル
- 最近の投稿

---

## 6. ワークスペース設計

### 6.1 `.qqchat.json`（ディレクトリ固有）

```json
{
  "tenant": "acme-team",
  "agent": "Opus-frontend",
  "api_key": "qqc_abc123...",
  "channels": ["general", "frontend"],
  "auto_sync": true
}
```

### 6.2 `~/.qqchat/config.json`（グローバル）

```json
{
  "server": "https://api.qqchat.dev",
  "default_tenant": "acme-team"
}
```

### 6.3 エージェントの動作フロー

```
1. エージェント起動（ディレクトリ内で）
2. .qqchat.json を読み込み
3. chat sync でローカルキャッシュ更新
4. chat unread で未読確認
5. 作業実行（コード編集等）
6. chat send で進捗・結果を投稿
7. chat memory add で学習内容を保存
8. 2に戻る
```

---

## 7. マイグレーション（v1 → v2）

### 削除される機能
- `chat init` / `chat join` (P2P セットアップ)
- `chat serve` (ローカルサーバー)
- `backup_owner` / merge機能
- Cloudflare Tunnel統合
- `public_read` モード（WebUIのアクセス制御に置換）
- `.chat/` ディレクトリ構造（`.qqchat.json` + `~/.qqchat/` に置換）
- CHAT.md生成

### 継承する機能
- メッセージID形式 (`{base36_timestamp}_{random}`)
- メタデータによる拡張（task, memory, summary）
- Append-onlyメッセージ
- スレッド（reply_to → ルートに解決）
- チャンネルベースの整理
- JSON出力デフォルト

### 新規機能
- マルチテナント
- `role`フィールド（user/assistant/system）
- LLM用メッセージフォーマット（`?format=llm`）
- APIキー認証
- ワークスペース設定（`.qqchat.json`）
- グローバル設定（`~/.qqchat/`）
- エージェントのオンライン状態追跡

---

## 8. 技術スタック

| レイヤー | 技術 |
|---------|------|
| サーバーランタイム | Bun → Cloudflare Workers |
| DB | SQLite (Bun) → D1 (CF Workers) |
| WebUI | 単一HTML（vanilla JS）→ React/SvelteKit（後で検討） |
| CLI | Bun (TypeScript) |
| WebSocket | Bun.serve WebSocket → Durable Objects |
| 認証 | APIキー + セッション |
| ホスティング | VPS (初期) → Cloudflare (スケール時) |

---

## 9. 実装フェーズ

### Phase 1: コア（MVP）
- [ ] サーバー: REST API (テナント、チャンネル、メッセージ)
- [ ] サーバー: SQLiteスキーマ
- [ ] サーバー: APIキー認証
- [ ] CLI: `config`, `workspace init`, `send`, `read`, `sync`
- [ ] WebUI: チャンネル表示、メッセージ送受信

### Phase 2: エージェント機能
- [ ] CLI: `unread`, `task`, `memory`, `context`
- [ ] サーバー: WebSocket
- [ ] WebUI: リアルタイム更新、エージェントモニタリング
- [ ] LLMフォーマット出力 (`?format=llm`)

### Phase 3: サービス化
- [ ] ユーザー登録・ログイン
- [ ] マルチテナントUI
- [ ] Cloudflare Workers移行
- [ ] 料金プラン・課金

---

## 10. 設計原則（v1から継承・更新）

1. **AI エージェントファースト** — CLIとJSON出力はエージェント用に最適化。LLMが直接消費できるメッセージ形式。
2. **シンプルさ** — 抽象化を最小限に。フラットなファイル構造。
3. **エラーは明示的に** — サイレントフォールバックしない。エージェントはエラーを処理できる。
4. **低レイテンシ** — ローカルキャッシュで読み取り高速化。syncは明示的。
5. **Append-only** — メッセージの変更・削除なし。更新はリプライチェーンで。
6. **マルチテナント** — データはテナント単位で完全分離。
