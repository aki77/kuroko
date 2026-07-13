import { homedir } from "node:os";
import { join } from "node:path";

/** 設定。環境変数で上書き可能にしておく。 */
export const config = {
  /** Zoom文字起こしjsonlが保存されるディレクトリ */
  transcriptDir: process.env.KUROKO_TRANSCRIPT_DIR ?? join(homedir(), "zoom-transcripts"),

  /** claude -p を実行する専用の空作業ディレクトリ（CLAUDE.md自動探索を回避する） */
  claudeCwd: process.env.KUROKO_CLAUDE_CWD ?? join(homedir(), ".cache", "kuroko", "run"),

  /** 使用モデル */
  model: process.env.KUROKO_MODEL ?? "sonnet",

  /**
   * claude CLI の実行パス。Finder/Dockから起動するとログインシェルのPATHを
   * 継承せず `claude` が見つからないため、絶対パスで上書きできるようにする。
   * 未指定なら PATH 解決＋よくあるインストール先を探索する（resolveClaudeBin）。
   */
  claudeBin: process.env.KUROKO_CLAUDE_BIN,

  /**
   * 自動トリガーの閾値: 前回の提案生成以降、新規に確定した発話がこの件数たまったら
   * 次の提案を生成する。
   */
  triggerCueCount: Number(process.env.KUROKO_TRIGGER_CUES ?? 8),

  /** Claudeに渡す直近の発話数（長い会議でも応答性を保つため直近だけに絞る） */
  recentCueLimit: Number(process.env.KUROKO_RECENT_LIMIT ?? 40),

  /**
   * ファイル追記を検知してから実際にトリガー判定するまでのデバウンス(ms)。
   * jsonlは短時間に連続追記されるためまとめて処理する。
   */
  debounceMs: Number(process.env.KUROKO_DEBOUNCE_MS ?? 1500),

  /** claude -p 呼び出しのタイムアウト(ms) */
  claudeTimeoutMs: Number(process.env.KUROKO_CLAUDE_TIMEOUT_MS ?? 60_000),

  /** web検索プロセス(B)のタイムアウト(ms)。検索往復があるためAより長め。 */
  claudeWebTimeoutMs: Number(process.env.KUROKO_CLAUDE_WEB_TIMEOUT_MS ?? 90_000),

  /** 【開発用】指定すると過去ログをリプレイする隠しモード。過去ログJSONLのフルパス */
  replayFile: process.env.KUROKO_REPLAY_FILE,
  /** リプレイ再生速度の倍率（10で10倍速）。start差分をこの値で割って待機する */
  replaySpeed: Number(process.env.KUROKO_REPLAY_SPEED ?? 1),
  /** リプレイ時、行間の待機をこのms上限でクランプ（長い沈黙で止まって見えるのを防ぐ） */
  replayMaxGapMs: Number(process.env.KUROKO_REPLAY_MAX_GAP_MS ?? 30_000),
} as const;
