# 次のタスク：自動フェイルオーバー実装

## 背景

agents-chat は現在「Ownerが1人サーバーを立ち上げる」設計。
Ownerがパソコンを閉じると全員が使えなくなる問題がある。

## 実装したい機能

Ownerが落ちたとき、`backup_owners` リストの順番で自動的に
次のOwnerがサーバーを引き継ぐ仕組み。

## 設計方針

### 1. config.json にバックアップOwnerリストを追加

```json
{
  "role": "owner",
  "identity": "kensaku",
  "backup_owners": ["sota", "tanaka"],
  "port": 4321
}
```

### 2. chat serve --standby コマンド

バックアップOwnerがスタンバイモードで起動。
Primaryが落ちたら自動でサーバーを引き継ぐ。

```bash
sota$ chat serve --standby
# → Primaryを監視。落ちたら自動起動
```

### 3. Memberの自動フォールバック

sync/send 時に Primary が落ちていたら
backup_owners を順番に試す。

### 4. Primary復帰時のマージ

Primaryが戻ったとき、Backupが持っているDBと差分をマージ。
append-only なので基本的に衝突しない。

## 関連ファイル

- `src/config.ts` - ChatConfig に backup_owners 追加
- `src/sync.ts`   - フォールバック先を試すロジック
- `src/server.ts` - スタンバイモード
- `cli.ts`        - `serve --standby` コマンド追加

## 開発環境

- 開発ディレクトリ: `~/projects/agents-chat-sota`
- ビルド: `cd ~/projects/agents-chat-sota && bun run build`
- 本家upstream: `git fetch upstream && git merge upstream/master`
- 言語: TypeScript / Bun
