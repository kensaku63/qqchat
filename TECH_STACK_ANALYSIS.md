# 技術スタック分析レポート

## 調査対象

agents-chat の「ローカルファースト P2P チャット」に最適な技術スタックを、2025-2026年の最新トレンドを踏まえて評価する。

---

## 1. 同期エンジン: 何を使うか？

### 候補一覧

| 技術 | 概要 | 成熟度 | P2P対応 |
|---|---|---|---|
| **自作HTTP同期** | 3エンドポイントの軽量API | - (自作) | Owner-hosted |
| **cr-sqlite (vlcn.io)** | CRDT対応SQLite拡張。マルチライター | pre-1.0 (v0.15.1) | Yes |
| **libSQL / Turso** | SQLite fork。Embedded Replica同期 | 本番利用可 | No (クラウド必須) |
| **ElectricSQL** | Postgres→クライアント読み取り同期 | 本番利用可 | No (Postgres必須) |
| **Automerge 3.0** | CRDT汎用ライブラリ (Rust+WASM) | 安定 | トランスポート層次第 |
| **Yjs** | CRDT（リアルタイム共同編集向け） | 安定 | WebRTC provider |
| **Hypercore/Hyperswarm** | P2P append-onlyログ + DHT | 中 | Yes (真のP2P) |
| **Zero (Rocicorp)** | Postgres→クライアント同期 | 安定 | No (Postgres必須) |
| **DXOS / ECHO** | フルスタックP2Pフレームワーク | pre-1.0 | Yes |

### 評価

#### cr-sqlite
- **仕組み**: SQLiteにCRDT拡張を読み込み、`crsql_changes` 仮想テーブルで変更セットを抽出・適用。ネットワーク非依存
- **Bun互換性**: Linuxでは `db.loadExtension()` で読み込み可能。macOSはApple版SQLiteが拡張非対応のため別途ビルド必要
- **現状 (2026)**: pre-1.0 (v0.15.1)。メンテナーのMatt WonlawがRocicorp（Zero/Replicacheの会社）に移籍し、開発の継続性に疑問。Byzantine fault tolerance未実装。カウンター・リッチテキストCRDTも未完成
- **問題点**: 単一メンテナー、プラットフォーム毎のネイティブビルド必要、「ゼロ依存」の理念に反する
- **結論**: ❌ 不採用。append-onlyのチャットにマルチライターCRDTは過剰。プロジェクトの持続性リスクも高い

#### libSQL / Turso Embedded Replicas
- **仕組み**: Turso Cloudをハブに、ローカルSQLiteをレプリカとして同期
- **Bun互換性**: `@libsql/client` がBun対応済み
- **問題点**: Turso Cloudが必須 → 「外部サービス不要」の理念に反する。Ownerの自前サーバーでは使えない
- **結論**: ❌ 不採用。外部サービス依存を避けたい

#### ElectricSQL
- **仕組み**: 2024年に大幅ピボット。旧版（Postgres↔SQLite双方向CRDT同期）は廃止。新版はPostgresからの**読み取り専用**同期エンジン（"Shapes"）。書き込みは自前APIで実装する必要あり
- **問題点**: Postgres + Elixirベースの同期サービスが必要。P2PやSQLite-to-SQLite同期には対応していない
- **結論**: ❌ 不採用。アーキテクチャが根本的に合わない

#### Automerge
- **仕組み**: CRDTベースの汎用データ同期ライブラリ。Rust+WASM実装
- **現状 (2026)**: Automerge 3.0（2025年中期リリース）でメモリ使用量10x改善。2名のフルタイムメンテナー（Ink & Switch）
- **Bun互換性**: WASM実装のためBunでも動作可能
- **問題点**: append-onlyチャットには過剰。全操作の因果関係履歴を追跡するため、単純な追記には不要なオーバーヘッドが発生。データ形式がバイナリでAI可読性が低い
- **結論**: ❌ 不採用。将来共同編集機能が必要になれば再検討

#### Yjs
- **仕組み**: CRDTベースのリアルタイム共同編集ライブラリ。Pure JavaScript実装。npm 週間90万DL超
- **Bun互換性**: Pure JSのためBunで問題なく動作
- **問題点**: 共同テキスト編集（文字の挿入・削除・位置追跡）向け。append-onlyのチャットにはtombstone、vector clock、position tracking等のオーバーヘッドが不要
- **結論**: ❌ 不採用。解決する問題がこのユースケースより遥かに難しい

#### Hypercore / Hyperswarm
- **仕組み**: Hypercoreは分散append-onlyログ — チャットメッセージのデータ構造として**アーキテクチャ的に最も自然な fit**。HyperswarmがDHTベースのP2Pピア発見+ホールパンチングを提供
- **Bun互換性**: ❌ **致命的問題**。udx-native, sodium-native, hyperdht等のネイティブC/C++アドオン（node-gyp）に依存。BunのN-APIサポートは改善中だが、この複雑な依存ツリーは頻繁に互換性問題を起こす
- **問題点**: Bun非互換、NAT越えの信頼性、両ピアオフライン時の同期不可
- **結論**: ❌ 不採用。最もエレガントな設計だが、Bun互換性が決定的なブロッカー

#### Zero (Rocicorp) / Replicache
- **仕組み**: Postgres v15+ から クライアントSQLiteへの同期。Replicacheは保守モードに移行し、Zeroが後継
- **問題点**: Postgres + zero-cache Dockerコンテナが必要。クライアント-サーバーモデルでありP2Pではない
- **結論**: ❌ 不採用。サーバーインフラが必要で「ローカルファーストP2P」の真逆

#### DXOS / ECHO
- **仕組み**: フルスタックのローカルファーストP2Pフレームワーク（データ同期ECHO + ネットワーキングMESH + 認証HALO）
- **問題点**: pre-1.0。フレームワーク全体を採用する必要があり、単純なチャットには巨大すぎる依存
- **結論**: ❌ 不採用。将来の大規模コラボアプリなら再検討

#### 自作HTTP同期 ✅ 推奨
- **仕組み**: Bun.serve()で3エンドポイント。`GET /sync?since=` で差分取得
- **利点**:
  - 最もシンプル。コード量が少ない
  - append-onlyのチャットは同期が本質的に簡単（新しいメッセージを追記するだけ）
  - SQLiteとJSONLの両方を完全にコントロール可能
  - 外部依存ゼロ
  - AIエージェントがデバッグしやすい（HTTPなので `curl` で確認可能）
- **リスク**: 同時書き込みの競合 → タイムスタンプ順序で解決（チャットでは十分）

### 判断根拠

> **append-onlyデータにCRDTは不要。**
> チャットメッセージは追記のみで、編集・削除は稀。同時に送信されたメッセージはタイムスタンプ順に並べるだけで「正しい」結果になる。
> CRDTやレプリケーションエンジンが解決する「競合」は、このユースケースではほぼ発生しない。

---

## 2. ランタイム: Bun ✅ 現状維持

| 候補 | 評価 |
|---|---|
| **Bun** ✅ | SQLite組み込み（3-6x高速）、HTTPサーバー組み込み、TypeScript直接実行、.env自動読み込み |
| Deno | SQLite組み込みなし（外部モジュール必要）。権限モデルがCLI体験を損なう |
| Node.js | SQLite 22.5+で実験的サポートのみ。better-sqlite3が必要 |

**結論**: Bunが圧倒的に最適。変更不要。

---

## 3. データストレージ: SQLite + JSONL ✅ 現状維持（強化あり）

### 強化ポイント: SQLite FTS5（全文検索）

現仕様の `LIKE '%keyword%'` は遅い。SQLite FTS5 を使うことで、日本語を含む全文検索が高速化する。

```sql
-- FTS5テーブル（仮想テーブル）
CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,
    content=messages,
    content_rowid=rowid
);

-- トリガーで自動インデックス
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- 高速全文検索
SELECT * FROM messages WHERE rowid IN (
    SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'jwt AND auth'
);
```

### AI可読性の検証結果（2025年のベストプラクティス）

調査の結果、**JSONL + SQLite の二重構造**は2025年のAIエージェント設計のベストプラクティスと一致:

- **JSONL** = 監査証跡（audit trail）。AIが直接ファイルとして読める
- **SQLite** = セマンティックメモリ。検索・フィルタ・集計に使う

この二重構造は変更不要。

---

## 4. HTTPサーバー: Bun.serve() ✅ 現状維持（WebSocket追加）

### 強化ポイント: オプショナルWebSocket

リアルタイムは不要だが、`chat serve` 中にメンバーが接続していれば、WebSocketでプッシュ通知できると便利。

```
Member が chat read dev を実行
  ↓
通常: GET /sync?since=xxx でポーリング（0.05-0.1秒）
  ↓
強化: WebSocket接続中なら新着をプッシュ通知 → 即座に表示
```

Bun.serve() は WebSocket をネイティブサポートしているので追加コスト最小。

**優先度**: Phase 3（まずHTTPポーリングで十分動く）

---

## 5. トンネリング: Cloudflare Quick Tunnels ✅ 推奨

| 候補 | 無料枠 | ワンライナー | WebSocket | 安定性 | 備考 |
|---|---|---|---|---|---|
| **Cloudflare Quick Tunnels** ✅ | 完全無料、帯域無制限 | `cloudflared tunnel --url localhost:4321` | Yes | 高 | SSE非対応、同時200リクエスト制限 |
| Tailscale Funnel | 無料 (3ユーザーまで) | 2コマンド必要 | Yes | 高 | ポート443/8443/10000のみ |
| ngrok | ❌ 1GB/月、警告ページ表示 | `ngrok http 4321` (要認証) | Yes | 高 | 2025-2026年で無料枠が大幅制限 |
| bore | 完全無料 (OSS) | `bore local 4321 --to bore.pub` | N/A (TCP) | 中 | HTTPSなし、ポートランダム |
| Pinggy | 60分セッション制限 | `ssh -p 443 -R0:localhost:4321 a.pinggy.io` | Yes | 良 | ゼロインストール (SSH) |

**推奨**: Cloudflare Quick Tunnels
- 完全無料、帯域制限なし、アカウント不要
- CLIワンライナーで即座に `trycloudflare.com` のURLが発行される
- WebSocketは動作する（本プロジェクトのPhase 3で重要）
- **注意**: Quick Tunnelは毎回URLが変わる。永続URLが必要なら無料アカウントでNamed Tunnelを使う

**代替**: Tailscale Funnel（チームが既にTailscaleを使っている場合）
**注意**: ngrokは2025-2026年で無料枠が大幅に制限されたため非推奨

---

## 6. CLIフレームワーク

| 候補 | サイズ | Bun互換 | TypeScript DX | メンテナンス | 備考 |
|---|---|---|---|---|---|
| `util.parseArgs` (組み込み) | 0KB | Native | 基本的 | N/A | サブコマンド非対応 |
| **citty (unjs)** | ~2-3KB | Good | 優秀 | 活発 (UnJS) | 軽量、宣言的API |
| **gunshi** | ~2-4KB | **明示的サポート** | 優秀 | 活発 (kazupon) | Bun/Deno/Node対応、i18n、プラグイン |
| Commander.js | ~6KB | Good | 普通 | 優秀 | 最も実績あり。v15でESM専用 |
| cleye | ~3-4KB | Good | 良好 | ❌ 停滞 | メンテナンス不活発 |
| yargs | ~30KB | ❌ バグあり | 良好 | 活発 | `$0`がbunになるバグ。非推奨 |
| Bunli | 小 | Bun専用 | 良好 | 若い | Bun専用エコシステム |

### 推奨: citty or gunshi

**citty** (UnJS): Nuxt/Nitroチームのエコシステム。軽量で宣言的API。TypeScript型推論が優秀。
**gunshi**: kazupon (vue-i18n作者) による新しいCLIフレームワーク。Bun/Deno/Nodeを明示的にサポート。TypeScript-first、遅延読み込み対応、i18n組み込み。

Phase 1ではコマンド数が7つ（init, send, read, sync, channels, serve, join）。
`util.parseArgs` で始めて、サブコマンドが必要になった時点で citty か gunshi に移行する。

**理由**: まずは外部依存ゼロで始める。コマンド体系が固まってから軽量フレームワークを導入する方が手戻りが少ない。

---

## 7. ID生成

| 候補 | 特徴 |
|---|---|
| `crypto.randomUUID()` | Bun組み込み。UUIDv4。ソート不可 |
| **nanoid** | npm依存。短い。ソート不可 |
| **ULIDまたはタイムスタンプ+ランダム** ✅ | 時系列ソート可能。依存なし |

### 推奨: タイムスタンプベースのID

```
msg_{YYYYMMDDHHmmssSSS}_{random4chars}
例: msg_20260307103000123_a7x2
```

- 時系列ソートが自然にできる（チャットメッセージの最重要特性）
- `Date.now()` + `Math.random()` で生成可能（外部依存なし）
- 人間が読んで「いつのメッセージか」がわかる

---

## 最終推奨スタック

| 要素 | 選択 | 変更 |
|---|---|---|
| ランタイム | **Bun** | 変更なし |
| DB | **bun:sqlite + FTS5** | FTS5追加 |
| ファイル形式 | **JSONL** | 変更なし |
| HTTPサーバー | **Bun.serve()** | 変更なし |
| リアルタイム | **Bun.serve() WebSocket**（Phase 3） | 新規追加 |
| 同期方式 | **自作HTTP同期（3エンドポイント）** | 変更なし |
| トンネル | **Cloudflare Quick Tunnels** | 変更なし |
| CLI | **util.parseArgs → citty/gunshi** | 段階的移行 |
| ID生成 | **タイムスタンプベースID** | nanoidから変更 |
| ファイルI/O | **Bun.file / Bun.write** | 変更なし |

### 変更サマリ

元の仕様から **大きな変更は不要**。以下の強化のみ：

1. **SQLite FTS5** を追加（全文検索の高速化）
2. **WebSocket** をPhase 3で追加（オプショナルなリアルタイムプッシュ）
3. **IDをタイムスタンプベース** に変更（時系列ソート対応）

---

## なぜ「新しい技術」を採用しないのか

本プロジェクトの核心的な要件に照らすと:

| 要件 | 新技術（CRDT等）の問題 |
|---|---|
| **AI可読性** | CRDTのバイナリフォーマットはAIが読めない。JONLは直読みできる |
| **ゼロ依存** | cr-sqliteはネイティブビルド必要。Tursoは外部サービス必要 |
| **シンプルさ** | append-onlyのチャットにCRDTの複雑性は見合わない |
| **広がりやすさ** | 依存が増えるとインストールのハードルが上がる |

> **最新技術を使うことが目的ではない。**
> 「ディレクトリを作って `bun chat.ts` を叩くだけで動く」というシンプルさこそが、このプロジェクトの最大の武器。
> 技術スタックはそのシンプルさを支えるものであるべき。

---

## Sources

### 同期エンジン・CRDT
- [cr-sqlite GitHub](https://github.com/vlcn-io/cr-sqlite) / [cr-sqlite Intro](https://vlcn.io/docs/cr-sqlite/intro)
- [cr-sqlite Roadmap Discussion](https://github.com/vlcn-io/cr-sqlite/discussions/347)
- [Automerge 3.0 Announcement](https://automerge.org/blog/automerge-3/)
- [Yjs Documentation](https://docs.yjs.dev)
- [Hypercore GitHub](https://github.com/holepunchto/hypercore) / [Pear Documentation](https://docs.holepunch.to/)
- [Zero Sync Engine (Rocicorp)](https://zero.rocicorp.dev/)
- [DXOS Documentation](https://docs.dxos.org/)
- [ElectricSQL - Writes Guide](https://electric-sql.com/docs/guides/writes)
- [Turso Embedded Replicas](https://docs.turso.tech/features/embedded-replicas/introduction)
- [Turso Offline Writes](https://turso.tech/blog/introducing-offline-writes-for-turso)

### SQLite・データ形式
- [Bun SQLite Documentation](https://bun.com/docs/runtime/sqlite)
- [bun:sqlite loadExtension API](https://bun.com/reference/bun/sqlite/Database/loadExtension)
- [The SQLite Renaissance 2026](https://dev.to/pockit_tools/the-sqlite-renaissance-why-the-worlds-most-deployed-database-is-taking-over-production-in-2026-3jcc)
- [Distributed SQLite: LibSQL and Turso in 2026](https://dev.to/dataformathub/distributed-sqlite-why-libsql-and-turso-are-the-new-standard-in-2026-58fk)
- [AI Agent Memory Architecture (JSONL + SQLite)](https://dev.to/diego_falciola_02ab709202/every-ai-agent-framework-has-a-memory-problem-heres-how-i-fixed-mine-1ieo)
- [LLM Logging to SQLite](https://llm.datasette.io/en/stable/logging.html)

### ローカルファースト
- [Local-First Apps in 2025: CRDTs, Replication, Edge Storage](https://debugg.ai/resources/local-first-apps-2025-crdts-replication-edge-storage-offline-sync)
- [FOSDEM 2026 - Local-First Track](https://fosdem.org/2026/schedule/track/local-first/)
- [BoltAI Tech Stack Analysis for Offline-First Chat](https://docs.boltai.com/blog/tech-stack-analysis-for-a-cross-platform-offline-first-ai-chat-client)
- [The Spectrum of Local First Libraries](https://tolin.ski/posts/local-first-options)

### トンネリング
- [Cloudflare Quick Tunnels Docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Cloudflare Tunnel vs ngrok vs Tailscale](https://dev.to/mechcloud_academy/cloudflare-tunnel-vs-ngrok-vs-tailscale-choosing-the-right-secure-tunneling-solution-4inm)
- [Top Cloudflare Tunnel Alternatives 2026](https://pinggy.io/blog/best_cloudflare_tunnel_alternatives/)
- [Tailscale Funnel Docs](https://tailscale.com/kb/1223/funnel)
- [ngrok Free Tier Limitations (DDEV Issue)](https://github.com/ddev/ddev/issues/8101)

### CLIフレームワーク
- [gunshi Documentation](https://gunshi.dev/) / [gunshi GitHub](https://github.com/kazupon/gunshi)
- [citty GitHub (UnJS)](https://github.com/unjs/citty)
- [Bunli](https://bunli.dev/)
- [My JS CLI Stack 2025 (gunshi migration)](https://ryoppippi.com/blog/2025-08-12-my-js-cli-stack-2025-en)
- [Bun CLI Argument Parsing Guide](https://bun.com/docs/guides/process/argv)
