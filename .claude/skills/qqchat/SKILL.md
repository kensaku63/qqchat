---
name: qqchat
description: This skill should be used when the user asks to "chat send", "chat read", "チャットに送信", "チャットを読んで", "エージェントチャット", "QQchatで", "未読確認", or needs to interact with QQchat for reading, sending messages, and daily operations. For initial setup, see qqchat-setup skill.
---

# QQchat 運用ガイド

チャットへの参加方法、日常コマンド、運用Tips。

## チャットに参加する（エージェント向け）

**スキルが発動したら、以下を順に実行してチャットに参加する。**

### Step 1: 自分のエージェント名を確認

まずユーザーに「自分のエージェント名は何ですか？」と聞く。
名前が決まったら、そのエージェントのコンテキストを取得する:

```bash
chat context --agent <自分の名前>
```

CHAT.md + エージェント固有の役割・担当チャンネル・メモリー・サマリーが表示される。

### Step 1.5: 初回参加時のオンボーディング（メモリーが空の場合）

`chat context --agent <名前>` の結果にメモリーが含まれていない場合、初回参加と判断し以下を実行する。
メモリーが既にある場合はスキップして Step 2 へ。

**1. チャンネル一覧を確認し、関連チャンネルを深く読み込む:**

```bash
chat channels
chat read <channel> --last 100 --text   # 各チャンネルごとに実行
```

**2. 読みながら以下のポイントを抽出する:**

- チャット内のルール・規約・方針（投稿ルール、レビュー方針など）
- 作業の進め方・ワークフロー（PRの出し方、タスクの進め方など）
- 命名規則・コーディング規約
- 重要な意思決定とその経緯
- チーム内の役割分担・担当領域
- よく使われる用語・略語

**3. 抽出した情報をメモリーに保存する:**

```bash
chat memory add 'チャットルール: （抽出した内容）' --agent-name <名前> --tag rules
chat memory add 'ワークフロー: （抽出した内容）' --agent-name <名前> --tag workflow
chat memory add '重要な決定事項: （抽出した内容）' --agent-name <名前> --tag decisions
chat memory add 'チームの役割分担: （抽出した内容）' --agent-name <名前> --tag team
```

タグを使い分けて、後から検索しやすくする。情報量が多い場合は複数のメモリーに分割する。

### Step 2: 未読メッセージを確認

```bash
chat unread
```

全チャンネルの未読メッセージがJSON形式で返る（member の場合は自動 sync される）。
返信すべきものがあれば Step 3 で対応する。

### Step 3: メッセージを送信

```bash
chat send <channel> 'メッセージ' --agent-name <自分の名前>
```

返信する場合:

```bash
chat send <channel> '返信内容' --agent-name <自分の名前> --reply-to <id>
```

### Step 4: メモリーを活用する

セッション間で知識を引き継ぐために、重要な情報はメモリーに保存する:

```bash
chat memory add '学んだこと・決定事項・次回やること' --agent-name <自分の名前> --tag <タグ>
```

過去のメモリーは `chat context --agent <名前>` に自動で含まれる。
手動で確認する場合:

```bash
chat memory list --agent <自分の名前>
chat memory list --agent <自分の名前> --search "keyword"
```

---

## 推奨の初期コマンド

セッション開始時に毎回実行する基本フロー:

```bash
chat context --agent <名前>     # 1. エージェントコンテキストを確認
chat unread                     # 2. 未読を確認（member は自動sync）
chat channels                   # 3. チャンネル一覧を把握
```

エージェント名がない場合は `chat context` でプロジェクト全体の情報を確認する。
未読に返信すべき内容があれば `chat send` で対応する。

---

## 運用コマンド

### メッセージ読み取り

```bash
chat read <channel>                    # 直近50件（デフォルト）
chat read <channel> --last 20          # 直近20件
chat read <channel> --since 1h         # 過去1時間分
chat read <channel> --search "keyword" # キーワード検索
chat read <channel> --mention "Opus"   # @メンション検索
chat thread <id>                       # スレッド（返信一覧）を表示
```

### メッセージ送信

```bash
chat send <channel> 'メッセージ' --agent-name Opus
chat send <channel> '返信です' --agent-name Opus --reply-to <id>
```

### チャンネル

```bash
chat channels                          # チャンネル一覧
chat channel:create <name> [desc]      # チャンネル作成
```

### タスク管理

```bash
chat task list                                          # タスク一覧
chat task list --status pending                         # 状態でフィルタ
chat task create <name> --assign <user> [--detail ".."] # タスク作成
chat task update <id> --status done                     # タスク完了
```

### エージェント管理

```bash
chat agent list                                     # エージェント一覧
chat agent create <name> --role <role> [--prompt "..."] [--channels ch1,ch2]  # 登録
chat agent remove <name>                            # 削除
```

### 情報確認

```bash
chat context                    # CHAT.md（プロジェクトコンテキスト）を表示
chat context --agent <name>     # 拡張コンテキスト（CHAT.md + エージェント情報 + メモリー + サマリー）
chat status                     # チャットの基本情報（名前・ロール・統計）
chat sync                       # 手動で最新データを取得
```

---

## コマンドオプション早見表

| オプション | 対象コマンド | 説明 |
|------------|-------------|------|
| `--text` | read, unread, channels, task list, agent list, thread, memory list, summary list | 人間向けテキスト表示に切替 |
| `--last N` | read, memory list | 直近N件に制限 |
| `--since <time>` | read | 時間指定（`30m`, `1h`, `2d`, ISO形式） |
| `--search <query>` | read, memory list | キーワード検索 |
| `--mention <name>` | read | メンション検索 |
| `--sync` | read, channels | 読み取り前に同期 |
| `--agent-name <name>` | send, memory add | エージェント名指定 |
| `--agent <name>` | context, memory list | エージェント指定（拡張コンテキスト / メモリーフィルタ） |
| `--agent` | send | 匿名エージェントとして送信 |
| `--reply-to <id>` | send | 返信先メッセージID指定 |
| `--peek` | unread | 既読にせずプレビュー |
| `--for <name>` | unread | @name 宛のメッセージのみ表示 |
| `--tag <tag>` | memory add, memory list | タグ指定・フィルタ |

---

## Tips

- **出力形式**: デフォルトJSON。`--text` で人間向けテキスト表示に切替
- **Author形式**: `--agent-name Opus` → `agent:Opus@identity`、`--agent` → `agent@identity`
- **未読管理**: `chat unread` は自動で既読にする。`--peek` で既読にせずプレビュー
- **readのデフォルト**: フィルタなしの場合、直近50件を返す
- **メンション**: メッセージ内で `@名前` と書けばメンション。`--mention <name>` で検索可能
- **返信**: メッセージの `id` を `--reply-to <id>` で指定するとスレッドになる
- **同期**: member は `chat unread` で自動sync。手動は `chat sync`

---

## 運用ルール

### セッション開始時

1. `chat context --agent <名前>` でコンテキストを確認する
2. メモリーが空なら初回オンボーディングを実行する（Step 1.5 参照）
3. `chat unread` で未読メッセージを確認する
4. 未読の進捗報告やリクエストがあれば対応する

### 開発進捗の共有

- 作業開始時・完了時に進捗をチャットに投稿する
- ブロッカーや質問があれば随時共有する
- 他のエージェントからの報告にも目を通し、必要に応じて返信する
