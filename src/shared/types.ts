// メイン ↔ レンダラ間でやり取りする型定義

/** 文字起こしの1発話（seqごとに最新revisionを採用したあとの確定形） */
export interface Cue {
  seq: number;
  speaker: string;
  text: string;
  revision: number;
}

/** Claudeが返す提案（--json-schema で構造化出力させる形と一致させる） */
export interface Suggestion {
  /** 今の話題の見出し（例:「Firestoreバックアップ運用」） */
  topic: string;
  /** 今の議論の要約（DISCUSSION） */
  discussion: string;
  /** 次に話すべきこと（相手には聞くべきこと／本人には続けて話すべきこと） */
  questions: string[];
  /** Web検索で補った背景知識（FROM THE WEB） */
  web: WebNote[];
  /** 実装コードから確認した仕様(FROM THE CODE) */
  code: CodeNote[];
}

export interface WebNote {
  /** 補足の見出し */
  title: string;
  /** 補足の中身（1〜2文） */
  detail: string;
  /** 出典URL（Web検索の参照元。無い場合あり） */
  url?: string;
}

export interface CodeNote {
  /** 補足の見出し（例: 「保存先は userData/settings.json」） */
  title: string;
  /** 実装から読み取った事実（1〜2文） */
  detail: string;
  /** 参照した実装の位置（例: "src/main/settings-store.ts:12"）。無い場合あり */
  ref?: string;
  /**
   * ref（先頭行範囲）を指す GitHub blob URL。GitHub リポジトリで解決できたときだけ
   * メイン側で付与。未解決（非git/行番号なし/不正ref）なら省略され、レンダラは
   * ref をプレーンテキスト表示する（WebNote.url と同じ「リンク化できるなら url」パターン）。
   */
  url?: string;
}

/** レンダラに送る提案更新イベント */
export interface SuggestionUpdate {
  suggestion: Suggestion;
  /** 生成に使ったミーティング（jsonl）ファイル名 */
  meetingFile: string;
  /** 生成完了時刻（ISO文字列。Date.now()回避のためメイン側で付与） */
  updatedAt: string;
  /** この提案生成にかかった実時間(ms)。A/B並行・C逐次・タイムアウトを含む壁時計計測 */
  durationMs: number;
  /** 累積コスト(USD)。サブスクでは参考値 */
  cumulativeCostUsd: number;
}

/** レンダラに送る状態イベント（生成中/待機中など） */
export type Status =
  | { kind: "idle" }
  | { kind: "waiting"; pendingCues: number; needed: number }
  | { kind: "querying" }
  | { kind: "error"; message: string }
  | { kind: "no-meeting" };

/** アプリ全体の設定。値は config.ts が env > 保存済みJSON > 既定値の優先順位で解決する */
export interface Config {
  transcriptDir: string;
  claudeCwd: string;
  model: string;
  claudeBin?: string;
  triggerCueCount: number;
  recentCueLimit: number;
  debounceMs: number;
  claudeTimeoutSec: number;
  claudeWebTimeoutSec: number;
  claudeCodeTimeoutSec: number;
  replayFile?: string;
  replaySpeed: number;
  replayMaxGapMs: number;
  replaySkipLines: number;
  myName?: string;
  contentProtection: boolean;
  projectDir?: string;
  meetingContext?: string;
}

/** GUIで編集可能なキー（この順序でフォームに並べる） */
export const EDITABLE_KEYS = [
  "model",
  "myName",
  "triggerCueCount",
  "recentCueLimit",
  "debounceMs",
  "claudeTimeoutSec",
  "claudeWebTimeoutSec",
  "claudeCodeTimeoutSec",
  "transcriptDir",
  "projectDir",
  "meetingContext",
  "contentProtection",
] as const;
export type EditableKey = (typeof EDITABLE_KEYS)[number];
export type EditableConfig = Pick<Config, EditableKey>;

/** renderer(設定ウィンドウ)に渡す状態。現在の実効値＋envで固定中か */
export interface ConfigState {
  values: EditableConfig;
  envLocked: Record<EditableKey, boolean>;
}
