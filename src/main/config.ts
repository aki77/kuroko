import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, ConfigState, EditableConfig, EditableKey } from "../shared/types";
import { EDITABLE_KEYS } from "../shared/types";

/** GUI編集対象外（env専用）も含む全項目の既定値 */
const DEFAULTS: Config = {
  /** 文字起こしjsonlが保存されるディレクトリ */
  transcriptDir: join(homedir(), "zoom-transcripts"),

  /** claude -p を実行する専用の空作業ディレクトリ（CLAUDE.md自動探索を回避する） */
  claudeCwd: join(homedir(), ".cache", "kuroko", "run"),

  /** 使用モデル */
  model: "sonnet",

  /**
   * claude CLI の実行パス。Finder/Dockから起動するとログインシェルのPATHを
   * 継承せず `claude` が見つからないため、絶対パスで上書きできるようにする。
   * 未指定なら PATH 解決＋よくあるインストール先を探索する（resolveClaudeBin）。
   */
  claudeBin: undefined,

  /**
   * 自動トリガーの閾値: 前回の提案生成以降、新規に確定した発話がこの件数たまったら
   * 次の提案を生成する。
   */
  triggerCueCount: 8,

  /** Claudeに渡す直近の発話数（長い会議でも応答性を保つため直近だけに絞る） */
  recentCueLimit: 40,

  /**
   * ファイル追記を検知してから実際にトリガー判定するまでのデバウンス(ms)。
   * jsonlは短時間に連続追記されるためまとめて処理する。
   */
  debounceMs: 1500,

  /** claude -p 呼び出しのタイムアウト(秒) */
  claudeTimeoutSec: 60,

  /** web検索プロセス(B)のタイムアウト(秒)。検索往復があるためAより長め。 */
  claudeWebTimeoutSec: 90,

  /** コード参照プロセス(C)のタイムアウト(秒)。Read/Grep/Globでの探索があるためAより長め。 */
  claudeCodeTimeoutSec: 180,

  /** 【開発用】指定すると過去ログをリプレイする隠しモード。過去ログJSONLのフルパス */
  replayFile: undefined,
  /** リプレイ再生速度の倍率（10で10倍速）。start差分をこの値で割って待機する */
  replaySpeed: 1,
  /** リプレイ時、行間の待機をこのms上限でクランプ（長い沈黙で止まって見えるのを防ぐ） */
  replayMaxGapMs: 30_000,
  /** リプレイ時、有効発話行の先頭からこの件数をスキップして再生を始める（挨拶等の読み飛ばし用） */
  replaySkipLines: 0,

  /** 本人（ユーザー自身）の話者名。文字起こしの話者名（表示名）に合わせる。未設定なら本人識別なしで動く */
  myName: undefined,

  /**
   * 会議中に実装から仕様を確認する対象の自プロジェクトディレクトリ。
   * 未設定ならコード参照プロセス(C)は一切走らない。
   * claude -p の --add-dir に渡すだけで --setting-sources "" は維持するため、
   * CLAUDE.md/hooks/MCPは読み込まれずRead/Grep/Globの読み取り専用参照になる。
   */
  projectDir: undefined,

  /**
   * その会議で話す予定のアジェンダ・議題資料などの事前コンテキスト。
   * 会議ごとに異なるため永続化はせず、起動ごとに空へリセットする（projectDirと同じ扱い）。
   * 提案生成プロセス A（要約）と C（コード参照）のプロンプトに埋め込む。B（Web検索）には渡さない。
   */
  meetingContext: undefined,

  /** ★Cluelyの肝: ONでオーバーレイを画面共有・画面録画に映さない。デバッグ時のスクショ共有用にOFFへ切替え可能にする */
  contentProtection: true,
};

/** env(KUROKO_*) の生の値。GUI編集対象キーのみ、envLockedキーの判定と正規化の入力に使う */
const RAW_ENV: Record<EditableKey, string | undefined> = {
  model: process.env.KUROKO_MODEL,
  myName: process.env.KUROKO_MY_NAME,
  triggerCueCount: process.env.KUROKO_TRIGGER_CUES,
  recentCueLimit: process.env.KUROKO_RECENT_LIMIT,
  debounceMs: process.env.KUROKO_DEBOUNCE_MS,
  claudeTimeoutSec: process.env.KUROKO_CLAUDE_TIMEOUT_SEC,
  claudeWebTimeoutSec: process.env.KUROKO_CLAUDE_WEB_TIMEOUT_SEC,
  claudeCodeTimeoutSec: process.env.KUROKO_CLAUDE_CODE_TIMEOUT_SEC,
  transcriptDir: process.env.KUROKO_TRANSCRIPT_DIR,
  projectDir: process.env.KUROKO_PROJECT_DIR,
  meetingContext: process.env.KUROKO_MEETING_CONTEXT,
  contentProtection: process.env.KUROKO_CONTENT_PROTECTION,
};

/**
 * 起動時に一度だけ確定する「envで固定中か」。以降不変（GUI操作では変わらない）。
 * normalizeString/normalizeOptionalName と同じ基準（trimして空なら未設定扱い）で判定する。
 * こうしないと `KUROKO_MY_NAME=`（空文字）等で実効値は未設定なのにGUIだけロックされてしまう。
 */
const envLockedKeys: Record<EditableKey, boolean> = Object.fromEntries(
  EDITABLE_KEYS.map((k) => [k, !!RAW_ENV[k]?.trim()]),
) as Record<EditableKey, boolean>;

/**
 * 常にsettings.jsonへ永続化しない（env固定時を除く）キーの集合。envLockedKeysと対称の仕組み。
 * projectDir/meetingContextは会議ごとに変わるため、起動ごとに空へリセットしたい（非永続化）。
 */
const NON_PERSISTED_KEYS = new Set<EditableKey>(["projectDir", "meetingContext"]);

/**
 * 消費側は `import { config } from "./config"` して `config.xxx` を都度読むため、
 * このオブジェクト自体の参照は固定し、中身だけを書き換える（Object.assign）。
 * こうすることで GUI からの変更が全消費側に無改修で伝播する。
 *
 * GUI編集対象外（env専用）のキーは、ここで一度だけ env から解決して固定値にする。
 */
export const config: Config = {
  ...DEFAULTS,
  claudeCwd: process.env.KUROKO_CLAUDE_CWD ?? DEFAULTS.claudeCwd,
  claudeBin: process.env.KUROKO_CLAUDE_BIN,
  replayFile: process.env.KUROKO_REPLAY_FILE,
  replaySpeed: normalizePositiveNumber(process.env.KUROKO_REPLAY_SPEED, DEFAULTS.replaySpeed),
  replayMaxGapMs: normalizeNumber(process.env.KUROKO_REPLAY_MAX_GAP_MS, DEFAULTS.replayMaxGapMs),
  replaySkipLines: normalizeNumber(process.env.KUROKO_REPLAY_SKIP_LINES, DEFAULTS.replaySkipLines, 0),
};

/** 数値項目を正規化する。外部入力(env/JSON)を信頼せず、Number()→NaN/範囲を最小値1にクランプする */
function normalizeNumber(raw: unknown, fallback: number, min = 1): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.trunc(n));
}

/**
 * 倍率など小数を許す正の数を正規化する（trunc/最小値クランプをしない）。
 * replaySpeed専用: 0.5倍速のようなfractionalな指定を壊さないため normalizeNumber とは分離する。
 */
function normalizePositiveNumber(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeString(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed || fallback;
}

function normalizeOptionalName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return raw.trim() || undefined;
}

/** boolean項目を正規化する。env由来の文字列("true"/"false")にも対応する */
function normalizeBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw; // GUI/JSON からの真偽値
  if (typeof raw === "string") {
    // env は文字列でしか来ない。trimして空なら未設定扱い（envLockedKeysの判定基準と揃える）
    const s = raw.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return fallback;
}

/** 1キー分を「値の候補（string|number|undefined等、raw）→正規化済みの実効値」に変換する */
function normalizeEditable(key: EditableKey, raw: unknown): EditableConfig[typeof key] {
  switch (key) {
    case "model":
      return normalizeString(raw, DEFAULTS.model);
    case "triggerCueCount":
      return normalizeNumber(raw, DEFAULTS.triggerCueCount);
    case "recentCueLimit":
      return normalizeNumber(raw, DEFAULTS.recentCueLimit);
    case "debounceMs":
      return normalizeNumber(raw, DEFAULTS.debounceMs, 0);
    case "claudeTimeoutSec":
      return normalizeNumber(raw, DEFAULTS.claudeTimeoutSec);
    case "claudeWebTimeoutSec":
      return normalizeNumber(raw, DEFAULTS.claudeWebTimeoutSec);
    case "claudeCodeTimeoutSec":
      return normalizeNumber(raw, DEFAULTS.claudeCodeTimeoutSec);
    case "transcriptDir":
      return normalizeString(raw, DEFAULTS.transcriptDir);
    // 自由記述の任意文字列（trimして空ならundefined）。追加時はここにcaseを足す
    case "myName":
    case "projectDir":
    case "meetingContext":
      return normalizeOptionalName(raw);
    case "contentProtection":
      return normalizeBoolean(raw, DEFAULTS.contentProtection);
  }
}

/**
 * 起動時に一度呼ぶ。優先順位 `env > persisted(保存済みJSON) > DEFAULTS` で
 * 各キーを解決し、config オブジェクトの中身を書き換える。
 * **main の watcher 起動より前に呼ぶこと**（transcriptDir が watcher に使われるため）。
 */
export function loadConfig(persisted: Partial<EditableConfig> | null): void {
  const resolved = {} as Record<EditableKey, unknown>;
  for (const key of EDITABLE_KEYS) {
    // env固定 or 非永続化キーはpersistedを無視し、常にenvのみを参照する（非永続化キーは起動ごとにリセットしたいため）。
    const raw =
      envLockedKeys[key] || NON_PERSISTED_KEYS.has(key)
        ? RAW_ENV[key]
        : (persisted?.[key] ?? RAW_ENV[key]);
    resolved[key] = normalizeEditable(key, raw);
  }
  Object.assign(config, resolved);
}

/**
 * GUIからの変更を適用する。env固定キーは無視し、それ以外を正規化して反映する。
 * 呼び出し側で永続化(writeSettings)・watcher再起動判定を行う。
 */
export function applyEditable(next: Partial<EditableConfig>): void {
  const resolved = {} as Record<EditableKey, unknown>;
  for (const key of EDITABLE_KEYS) {
    if (envLockedKeys[key]) continue; // env固定キーはGUIから変更不可
    if (!(key in next)) continue;
    resolved[key] = normalizeEditable(key, next[key]);
  }
  Object.assign(config, resolved);
}

/** config/DEFAULTS から EditableConfig 部分だけを抜き出す */
function pickEditable(src: Config): EditableConfig {
  return Object.fromEntries(EDITABLE_KEYS.map((k) => [k, src[k]])) as EditableConfig;
}

/** 現在の実効値と envLocked を返す。設定ウィンドウの初期表示に使う */
export function getConfigState(): ConfigState {
  return { values: pickEditable(config), envLocked: envLockedKeys };
}

/**
 * 永続化すべき編集値（＝env固定でも非永続化キーでもないキーの実効値）だけを返す。
 * env固定キーは書き込まない（applyEditable がスキップするのと対称。
 * env を外したとき、過去のenv値が settings.json に残って復帰しない事故を防ぐ）。
 * 非永続化キー（NON_PERSISTED_KEYS）も書き込まない（起動時は常に空にリセットする）。
 */
export function getPersistableValues(): Partial<EditableConfig> {
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE_KEYS) {
    if (envLockedKeys[key] || NON_PERSISTED_KEYS.has(key)) continue;
    out[key] = config[key];
  }
  return out as Partial<EditableConfig>;
}
