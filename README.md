# kuroko

会議の文字起こしをリアルタイムに監視し、会議中に「今の話題の要約」「次に話すべきこと」「Web検索による背景知識」「実装コードから確認した仕様」を、画面隅の半透明オーバーレイでさりげなく提案するツール。

裏側のLLMはサブスク契約の `claude -p`（既定: haiku、`KUROKO_MODEL`で変更可）を使います。

## 特徴

- **画面共有・録画に映らない**オーバーレイ（macOSの `NSWindowSharingNone` / Electron `setContentProtection`）
- 常に最前面・半透明ガラスUI・全仮想デスクトップで表示
- 新しい発言が一定数たまるたびに**自動で提案を更新**（手動トリガーも可）
- `claude -p --json-schema` による構造化出力で、提案を4ブロック（話題/次に話すべきこと/FROM THE WEB/FROM THE CODE）に整形
- Web検索（`WebSearch`ツール）で会話中の専門用語を補足
- 自プロジェクトの実装がテーマになったときだけ、Read/Grep/Globで実装を読んで仕様を裏付け（`参照プロジェクトディレクトリ` 設定時のみ。CLAUDE.md/hooks/MCPは読み込まない）
- 会議ごとのアジェンダ・議題資料を専用ウィンドウで事前登録でき、提案生成時のコンテキストとして加味される（起動ごとにリセットされ非永続化）

## 前提

- `claude` CLI がインストール済みで、サブスク契約でログイン済みであること
- 会議の文字起こしが `~/zoom-transcripts/*.jsonl` にリアルタイム保存されていること
  （1行1JSON: `{seq, speaker, text, revision, ...}`、同一 `seq` が `revision` を上げながら
   訂正追記される形式に対応。この形式で書き出せれば供給元は問わない。
   例: Zoom自分用メモの文字起こしを [zoom-notes-jsonl](https://github.com/aki77/zoom-notes-jsonl) などで変換）

## セットアップ

```sh
pnpm install
pnpm start
```

## コマンド

lint/formatは [Biome](https://biomejs.dev/) を使用（`pnpm test` の `pretest` でも `biome check` を自動実行）。

```sh
pnpm run lint     # lintのみ（検出）
pnpm run format   # フォーマットのみ適用
pnpm run check    # lint+format+import整理をまとめて適用
```

## 使い方（ショートカット）

| キー | 動作 |
| --- | --- |
| `⌘⇧K` | 今すぐ提案を再生成 |
| `⌘⇧H` | オーバーレイの表示/非表示 |
| `⌘⇧X` | クリックスルー（マウス素通り）トグル |

タイトルバーをドラッグしてウィンドウを移動できます。

タイトルバーの「📋 通常」/「🎯 集中」ボタンで情報量モードを切り替えられます。集中モード（メインで話すとき向け）はFROM THE WEB / FROM THE CODEの提案件数を生成段階で最大2件に厳選します。通常モード（ナビゲーターとして参加するとき向け）は現状どおり0〜4件です。この設定は設定ウィンドウ・環境変数からは変更できず、起動ごとに常に通常モードへリセットされる（`KUROKO_PROJECT_DIR` 等とは異なり非永続化専用）。

議論の要約本文はトピック見出し（▶/▼インジケータ付き）をクリックすると折りたたみ/展開できます。トピック名自体は折りたたみ時も常に表示されます。集中モードでは要約本文がデフォルトで折りたたまれ（通常モードは展開）、この開閉状態は保存されません。手動で開閉した状態は、モードを切り替えるか別の会議に切り替わるまで維持され（同一会議内で新しい提案が届いても保たれます）、以降は再びモードに応じたデフォルトへ戻ります。

## 会議コンテキスト（アジェンダ・議題資料）

オーバーレイの「📝 コンテキスト」ボタンから専用ウィンドウを開き、この会議のアジェンダや議題資料を貼り付け・ファイル読込（.md/.txt）できる。フォーカスを外すと自動で確定され、2000字を超える長文は要約してから登録される。登録済みかどうかはオーバーレイ側に「登録済み」バッジとして即座に反映される。

内容は起動ごとに空へリセットされ、`settings.json` には保存されない（`KUROKO_PROJECT_DIR` と同じ非永続化パターン）。

## 設定

下表の項目はオーバーレイ右上の ⚙ ボタンから開く**設定ウィンドウでGUI変更・永続化**できる（保存は `~/Library/Application Support/kuroko/settings.json`）。変更は保存後すぐ反映される（`文字起こしディレクトリ` の変更時のみ監視を再起動する）。

環境変数でも設定でき、**優先順位は `環境変数 > GUI保存値 > 既定値`**。環境変数が設定されているキーは設定ウィンドウで編集不可（「envで固定中」表示）になる。

| 変数 | 既定値 | GUI | 説明 |
| --- | --- | --- | --- |
| `KUROKO_MODEL` | `haiku` | ✓ | 使用モデル |
| `KUROKO_FONT_SCALE` | `1.3` | ✓ | オーバーレイ文字サイズの倍率。小(`1.0`)/中(`1.3`)/大(`1.7`)のプリセット3択（自由入力不可・最も近い値にスナップ） |
| `KUROKO_MY_NAME` | （なし） | ✓ | 本人の話者名。設定するとその人の発話には「続けて話すべきこと」を提案 |
| `KUROKO_TRIGGER_CUES` | `8` | ✓ | 自動提案する新規発話の閾値 |
| `KUROKO_RECENT_LIMIT` | `40` | ✓ | Claudeに渡す直近発話数 |
| `KUROKO_DEBOUNCE_MS` | `1500` | ✓ | 追記検知後のデバウンス |
| `KUROKO_CLAUDE_TIMEOUT_SEC` | `60` | ✓ | 要約プロセス(A)のタイムアウト（秒） |
| `KUROKO_CLAUDE_WEB_TIMEOUT_SEC` | `90` | ✓ | Web検索プロセス(B)のタイムアウト（秒） |
| `KUROKO_CLAUDE_CODE_TIMEOUT_SEC` | `180` | ✓ | コード参照プロセス(C)のタイムアウト（秒） |
| `KUROKO_TRANSCRIPT_DIR` | `~/zoom-transcripts` | ✓ | 文字起こしjsonlの保存先 |
| `KUROKO_PROJECT_DIR` | （なし） | ✓ | 会議中に実装から仕様を確認する自プロジェクトのディレクトリ。未設定ならFROM THE CODEは無効 |
| `KUROKO_MEETING_CONTEXT` | （なし） | – | 会議のアジェンダ・議題資料（[会議コンテキスト](#会議コンテキストアジェンダ議題資料)参照）。非永続化のため設定ウィンドウの対象外だが、専用ウィンドウでの編集可否には同じ「envで固定中」ルールが適用される |
| `KUROKO_CLAUDE_CWD` | `~/.cache/kuroko/run` | – | claude -p を実行する作業ディレクトリ |
| `KUROKO_CLAUDE_BIN` | （PATH解決） | – | claude CLI の絶対パス |
| `KUROKO_MEETING_STALE_MIN` | `5` | – | 起動時、最新jsonlの最終更新がこの分数以上前なら会議とみなさず待機で起動（開発用チューニング値・単位:分）。待機中もそのファイルへの追記を検知したら会議を開始する |

`KUROKO_MY_NAME` は文字起こしに出る自分の話者名（表示名）に合わせると精度が上がる（多少の表記ゆれはLLM側で吸収される）。

`KUROKO_PROJECT_DIR` を設定すると、要約プロセス(A)が「今の議論が自プロジェクトの実装の詳細に関わる」と判断したときだけ、コード参照プロセス(C)がRead/Grep/Globで実装を調べてFROM THE CODEブロックに表示する。判断はA自身が構造化出力の `needsCode` フラグで行うため、毎回自動で実装を探索するわけではない。

## 開発用: リプレイモード（会議なしで動作検証）

過去の実ログを指定すると、そのタイムスタンプに沿った時間差で仮の文字起こしファイルを生成し、本番と同一の監視〜提案生成経路を再現できる。会議を開かずに提案の出方を確認できる。先頭の挨拶等を読み飛ばして途中から再生することもできる。

```sh
# 既存の実ログを10倍速でリプレイ
KUROKO_REPLAY_FILE=~/zoom-transcripts/2026-07-02T140054-transcript.jsonl \
KUROKO_REPLAY_SPEED=10 \
pnpm start

# 先頭30行（挨拶等）をスキップしてから再生
KUROKO_REPLAY_FILE=~/zoom-transcripts/2026-07-02T140054-transcript.jsonl \
KUROKO_REPLAY_SPEED=10 \
KUROKO_REPLAY_SKIP_LINES=30 \
pnpm start
```

- `KUROKO_REPLAY_FILE` を指定したときだけ有効化される隠しモード（未指定なら通常起動）。
- `transcriptDir` 内に `<現在時刻>-transcript.jsonl` を作り、元ログを1行ずつ加工なしで追記していく。watcherが自動で「最新の会議」として拾う。
- アプリ終了時（⌘Q / ターミナルでの `Ctrl+C`）に仮ファイルは削除され、`zoom-transcripts` を汚さない。

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `KUROKO_REPLAY_FILE` | （なし） | リプレイ元の過去ログjsonlのフルパス。指定するとリプレイモードで起動 |
| `KUROKO_REPLAY_SPEED` | `1` | 再生速度の倍率（`10` で10倍速） |
| `KUROKO_REPLAY_MAX_GAP_MS` | `30000` | 行間の待機時間の上限（長い沈黙で止まって見えるのを防ぐ） |
| `KUROKO_REPLAY_SKIP_LINES` | `0` | 有効発話行の先頭からこの件数を読み飛ばしてから再生（挨拶等の読み飛ばし用） |

## アーキテクチャ

```
zoom-transcripts/*.jsonl
   │ (chokidar監視 / 最新ファイル=進行中の会議)
   ▼
watcher.ts     seqごと最新revisionを採用した確定発話リストを生成
               起動時、最新jsonlの最終更新が古い（既定5分以上前、KUROKO_MEETING_STALE_MIN）場合は
               会議として採用せず待機(no-meeting)で起動。待機中もそのファイルへの追記を監視し、
               追記が来たら会議を開始する
   ▼
orchestrator.ts  発話がN件たまったらトリガー（多重起動防止・デバウンス）
   ▼
suggester.ts   A: claude -p <model> --json-schema（要約+questions+needsCode判定）
               B: claude -p <model> --json-schema --allowedTools WebSearch（Aと同時に開始し、A/Cとは独立に並行実行）
               C: claude -p <model> --json-schema --allowedTools Read Grep Glob
                  （<model>は既定 haiku、KUROKO_MODELで変更可）
                  （Aの完了直後、AがneedsCode=trueと判定したときだけ発火。Bの完了は待たない。--add-dirで自プロジェクトを参照）
   │           （設定無効化 --setting-sources "" ＋ 空cwd で軽量・高速化。Cもこの前提は維持）
   │           （focusModeは生成開始時に1回だけ読み取り、同一提案内でB/Cに同じ値を使う。B/Cのプロンプト・スキーマではfocusMode=trueのとき最大件数を2件に絞る）
   │           （A/B/Cは完了ごとに `suggestion-part` をIPCで随時レンダラへ流す。全部揃った完成品は従来どおり `suggestion` で1件だけ通知）
   ▼ IPC
renderer/      Cluely風の半透明パネルに4ブロック描画
               `suggestion-part` はhistoryと別の「ライブ枠」へ到着順（A/B/Cの完了順は不定）に
               マージ描画し、`suggestion`（完成品）到着時にライブ枠をクリアしてhistoryへ1件push
```

## メモ: `claude -p` のチューニング

- `--setting-sources ""` でユーザー/プロジェクト設定を無効化 → CLAUDE.md/hooks/MCPの影響を排除し警告も抑止
- 専用の空ディレクトリ（`~/.cache/kuroko/run`）で実行 → CLAUDE.md自動探索を回避
- `--bare` はサブスク（OAuth）では使えない（`ANTHROPIC_API_KEY` を要求するため）
- Web検索ありは高品質だが遅い（〜40秒）。速度優先なら `suggester.ts` の `--allowedTools WebSearch` を外す
- `--setting-sources ""` を保ったまま `--add-dir` で実プロジェクトをRead/Grep/Glob参照させられる（CLAUDE.md/hooks/MCPは読み込まれない）。会議中に実装を「読むだけ」参照させたい場合に有効
- Web検索の出典URLは生成後に到達確認（HEAD、405/501等はGETフォールバック）し、404/410のときだけ url を落として title/detail は残す（`url-check.ts`）。エラー・タイムアウトや403/429/5xxなどの判定不能ケースは「疑わしきは残す」。ライブ枠（速報）は未検証で出し、完成品で差し替える。同一URLの判定結果はアプリ起動中プロセス内で3状態（到達不可/確定到達可能/判定不能）に分けてキャッシュし、到達不可・確定到達可能は長め、判定不能（一時的な障害の可能性がある）は短めのTTLとすることで、再検証によるレイテンシ増加を避ける

## 参考

Cluely / [AI-Giziroku](https://zenn.dev/uguisu_blog/articles/d777bd252bab6b) / miyagawa の live-assistant に着想を得ています。
