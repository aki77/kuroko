# kuroko

Zoomの文字起こしをリアルタイムに監視し、会議中に「今の話題の要約」「次に聞くべきこと」「Web検索による背景知識」を、画面隅の半透明オーバーレイでさりげなく提案するツール。

Cluely / [AI-Giziroku](https://zenn.dev/uguisu_blog/articles/d777bd252bab6b) / miyagawa の live-assistant に着想を得ています。裏側のLLMはサブスク契約の `claude -p`（sonnet）を使います。

## 特徴

- **画面共有・録画に映らない**オーバーレイ（macOSの `NSWindowSharingNone` / Electron `setContentProtection`）
- 常に最前面・半透明ガラスUI・全仮想デスクトップで表示
- 新しい発言が一定数たまるたびに**自動で提案を更新**（手動トリガーも可）
- `claude -p --json-schema` による構造化出力で、提案を3ブロック（話題/聞くべきこと/FROM THE WEB）に整形
- Web検索（`WebSearch`ツール）で会話中の専門用語を補足

## 前提

- `claude` CLI がインストール済みで、サブスク契約でログイン済みであること
- Zoomの文字起こしが `~/zoom-transcripts/*.jsonl` にリアルタイム保存されていること
  （別途 `zoom-notes-jsonl` などが生成する。1行1JSON: `{seq, speaker, text, revision, ...}`、
   同一 `seq` が `revision` を上げながら訂正追記される形式に対応）

## セットアップ

```sh
pnpm install
pnpm start
```

## 使い方（ショートカット）

| キー | 動作 |
| --- | --- |
| `⌘⇧K` | 今すぐ提案を再生成 |
| `⌘⇧H` | オーバーレイの表示/非表示 |
| `⌘⇧X` | クリックスルー（マウス素通り）トグル |

タイトルバーをドラッグしてウィンドウを移動できます。

## 設定（環境変数）

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `KUROKO_TRANSCRIPT_DIR` | `~/zoom-transcripts` | 文字起こしjsonlの保存先 |
| `KUROKO_MODEL` | `sonnet` | 使用モデル |
| `KUROKO_TRIGGER_CUES` | `8` | 自動提案する新規発話の閾値 |
| `KUROKO_RECENT_LIMIT` | `40` | Claudeに渡す直近発話数 |
| `KUROKO_DEBOUNCE_MS` | `1500` | 追記検知後のデバウンス |
| `KUROKO_CLAUDE_TIMEOUT_MS` | `60000` | claude -p のタイムアウト |

## アーキテクチャ

```
zoom-transcripts/*.jsonl
   │ (chokidar監視 / 最新ファイル=進行中の会議)
   ▼
watcher.ts     seqごと最新revisionを採用した確定発話リストを生成
   ▼
orchestrator.ts  発話がN件たまったらトリガー（多重起動防止・デバウンス）
   ▼
suggester.ts   claude -p sonnet --json-schema --allowedTools WebSearch
   │           （設定無効化 --setting-sources "" ＋ 空cwd で軽量・高速化）
   ▼ IPC
renderer/      Cluely風の半透明パネルに3ブロック描画
```

## メモ: `claude -p` のチューニング

- `--setting-sources ""` でユーザー/プロジェクト設定を無効化 → CLAUDE.md/hooks/MCPの影響を排除し警告も抑止
- 専用の空ディレクトリ（`~/.cache/kuroko/run`）で実行 → CLAUDE.md自動探索を回避
- `--bare` はサブスク（OAuth）では使えない（`ANTHROPIC_API_KEY` を要求するため）
- Web検索ありは高品質だが遅い（〜40秒）。速度優先なら `suggester.ts` の `--allowedTools WebSearch` を外す
