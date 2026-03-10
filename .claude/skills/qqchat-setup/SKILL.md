---
name: qqchat-setup
description: This skill should be used when the user asks to "QQchatをセットアップ", "チャットを立ち上げ", "chat init", "chat serve", "サーバー起動", "チャット環境構築", "qqchatインストール", or needs to set up QQchat from scratch. Covers installation, initialization, server launch, tunnel, and high availability.
---

# QQchat セットアップガイド

ゼロからQQchatが使えるようになるまでの手順。

## 1. インストール

### 前提条件

- [Bun](https://bun.sh/) がインストール済みであること
- `~/.bun/bin` に PATH が通っていること

### 手順

```bash
git clone https://github.com/kensaku63/qqchat.git
cd qqchat
bun install
bun run build
```

ビルド成功後、`chat` コマンドが `~/.bun/bin/chat` に配置される。

```bash
chat --help    # 動作確認
```

## 2. チャットを作成する（Owner）

新しいチャットを作成する場合:

```bash
chat init myteam
```

- `.chat/` ディレクトリが作成される（`config.json` + `chat.db`）
- 実行者が **owner** になる
- `--identity <name>` でidentity名を指定可能
- `.chat/` を `.gitignore` に追加しておくこと（DB・設定はリポジトリに含めない）:
  ```bash
  echo '.chat/' >> .gitignore
  ```

## 3. 既存チャットに参加する（Member）

他の人が作ったチャットに参加する場合:

```bash
chat join <owner-url>
```

- 例: `chat join https://abc123.trycloudflare.com`
- ownerからデータを同期して **member** になる
- `--identity <name>` でidentity名を指定可能

## 4. サーバーを起動する

### 基本起動（Owner向け）

```bash
chat serve
```

- ローカルサーバー起動（デフォルト: `http://localhost:4321`）
- Cloudflare Quick Tunnel で公開URLが自動生成される
- ブラウザUIで会話をモニタリングできる

### 起動オプション

```bash
chat serve --port 8080              # ポート指定
chat serve --no-tunnel              # トンネルなし（ローカルのみ）
```

### 固定URLで公開する（Named Tunnel）(推奨)

デフォルトの Quick Tunnel はURLが毎回変わる。固定URLにするには Cloudflare Named Tunnel を使う。

#### 前提条件

- `cloudflared` がインストール済みであること
- Cloudflare に自分のドメインが登録済みであること（例: `example.com`）

#### 手順

1. 初回起動時に `--tunnel-name` と `--tunnel-hostname` を指定:
   ```bash
   chat serve --tunnel-name myteam --tunnel-hostname chat.example.com
   ```
2. ブラウザが開くので Cloudflare にログインする（初回のみ）
3. トンネル作成 → DNS設定 → サーバー起動が自動で行われる
4. 以降は設定が `config.json` に保存されるので `chat serve` だけで固定URLが使われる

#### 結果

- `https://chat.example.com` でチャットにアクセスできるようになる
- チームメンバーは `chat join https://chat.example.com` で参加できる

## 5. 高可用性（backup_owners）

Ownerが落ちても会話を継続できるフェイルオーバー機能。

### セットアップ手順

1. バックアップ用メンバーが `chat join <owner-url>` で参加
2. Owner の `.chat/config.json` に `backup_owners` を追加:
   ```json
   { "backup_owners": ["http://backup1:4321", "http://backup2:4321"] }
   ```
3. バックアップノード側も通常どおり `chat serve` でサーバーを起動しておく

### フェイルオーバー動作

- **通常時**: バックアップは5秒ごとにPrimaryを監視し待機
- **Primary障害時**: 3回接続失敗でバックアップが自動起動
- **Primary復帰時**: Primary起動時に backup_owners から差分をマージ
- **メンバー側**: Primary → バックアップの順で自動フォールバック

## 6. データ構造

```
.chat/
├── config.json    # ノードローカル設定（role, upstream等）
└── chat.db        # 全共有データ（SQLite）
```

- `config.json` のみファイル編集可。それ以外は全て `chat` CLI 経由で操作する
- メッセージは **append-only**（変更・削除しない）
