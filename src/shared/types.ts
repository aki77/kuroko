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
}

export interface WebNote {
  /** 補足の見出し */
  title: string;
  /** 補足の中身（1〜2文） */
  detail: string;
  /** 出典URL（Web検索の参照元。無い場合あり） */
  url?: string;
}

/** レンダラに送る提案更新イベント */
export interface SuggestionUpdate {
  suggestion: Suggestion;
  /** 生成に使ったミーティング（jsonl）ファイル名 */
  meetingFile: string;
  /** 生成完了時刻（ISO文字列。Date.now()回避のためメイン側で付与） */
  updatedAt: string;
  /** この提案生成にかかったAPI時間(ms) */
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
