# CLAUDE.md

## コマンド
- ビルド: `pnpm run build`
- 開発時watch: `pnpm run dev`
- 起動: `pnpm start`
- テスト: `pnpm test`（`node --test --experimental-strip-types`、pretestでtsc型チェック）

## アーキテクチャ
watcher.ts（jsonl監視）→ orchestrator.ts（発話N件でトリガー）→ suggester.ts（claude -p ×3並行/逐次）→ IPC → renderer/（Electron UI）
詳細は README.md の「アーキテクチャ」節を参照。

## 重要な注意点
- `src/suggester.ts` が内部で spawn する `claude -p` には `--setting-sources ""` が付与されており、
  ユーザー/プロジェクトのCLAUDE.md・hooks・MCPを一切読み込まない設計。
  この動作を変える改修をする場合はREADMEの「メモ: claude -p のチューニング」節と整合させること。
- `KUROKO_PROJECT_DIR` / `KUROKO_MEETING_CONTEXT` は非永続化パターン（settings.jsonに保存しない）。
  同様の設定を追加する際はこのパターンを踏襲するか、意図的に外れるならその理由をコメントする。

## ドキュメント更新
README.mdに記載されている仕様（環境変数、設定項目、アーキテクチャ、ショートカット等）を変更した場合は、
コード変更と同じコミット/PR内でREADME.mdも必ず更新すること。
