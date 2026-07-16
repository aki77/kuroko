import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodeNote, Cue, Suggestion, WebNote } from "../shared/types";
import { isHttpsUrl } from "../shared/url";
import { config } from "./config";
import { buildGithubRefUrl, isPathDirty, isRefStale, resolveGitRepo } from "./git-url";

/** claude -p に渡す構造化出力スキーマ（A: 要約+questions+needsCode判定。WebSearchなしで速い） */
const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    topic: { type: "string", description: "今まさに話している話題の短い見出し" },
    discussion: { type: "string", description: "今の議論の2〜3文の要約" },
    questions: {
      type: "array",
      items: { type: "string" },
      description:
        "次に話すべきこと。相手が話しているなら聞くべきこと、本人が話しているなら続けて話すべきこと。1〜4個、なければ空配列",
    },
    needsCode: {
      type: "boolean",
      description:
        "今の議論が自プロジェクトの実装の詳細（仕様・挙動・データ構造）に関わっており、実装を確認すると議論が正確になる場合のみ true。一般的な話・実装に無関係な話なら false。",
    },
    codeQuery: {
      type: "string",
      description:
        "needsCode が true のとき、実装で確認すべき事柄を簡潔に（例: 「設定の保存先と永続化形式」）。false のとき空文字。",
    },
  },
  required: ["topic", "discussion", "questions", "needsCode", "codeQuery"],
  additionalProperties: false,
} as const;

/**
 * claude -p に渡す構造化出力スキーマ（B: web のみ。WebSearchを使うため遅い）。
 * 集中モード時はmaxItemsも2に絞る（プロンプト指示が主、これは二重防御）。
 */
function buildWebSchema(focusMode: boolean) {
  return {
    type: "object",
    properties: {
      web: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            detail: { type: "string" },
            url: {
              type: "string",
              description: "参照した出典ページの完全なURL（https）。無ければ省略",
            },
          },
          required: ["title", "detail"],
          additionalProperties: false,
        },
        ...(focusMode ? { maxItems: 2 } : {}),
        description: focusMode
          ? "会話に出た用語・技術・固有名詞のうち最も重要なものだけ、Web検索で補った背景知識（0〜2個）"
          : "会話に出た用語・技術・固有名詞をWeb検索で補った背景知識（0〜4個）",
      },
    },
    required: ["web"],
    additionalProperties: false,
  } as const;
}

/**
 * claude -p に渡す構造化出力スキーマ（C: 自プロジェクトの実装確認のみ。Read/Grep/Globを使うため遅い）。
 * 集中モード時はmaxItemsも2に絞る（プロンプト指示が主、これは二重防御）。
 */
function buildCodeSchema(focusMode: boolean) {
  return {
    type: "object",
    properties: {
      code: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            detail: { type: "string" },
            ref: {
              type: "string",
              description: "参照した実装の位置（例: \"src/main/settings-store.ts:12\"）。無ければ省略",
            },
          },
          required: ["title", "detail"],
          additionalProperties: false,
        },
        ...(focusMode ? { maxItems: 2 } : {}),
        description: focusMode
          ? "会議で話している仕様・挙動のうち最も重要なものだけを自プロジェクトの実装で裏付けた事実（0〜2個）"
          : "会議で話している仕様・挙動を自プロジェクトの実装で裏付けた事実（0〜4個）",
      },
    },
    required: ["code"],
    additionalProperties: false,
  } as const;
}

/**
 * A（要約+questions）用のシステムプロンプトを組み立てる。
 * myName が設定されている場合のみ、直近の発話主体（本人/相手）に応じて
 * questions の方向性（続けて話すべきこと／聞くべきこと）を切り替える指示を追加する。
 */
function buildSummarySystemPrompt(myName?: string): string {
  const questionsGuidance = myName
    ? `2. questions: 「次に話すべきこと」を挙げる。文字起こしは各行が「話者名: 発話」の形式。行頭の話者名が「${myName}」（または表記が非常に近いもの）の行が本人の発話。直近の発話主体で判断し、本人以外が話している文脈なら「聞くべきこと」（次に確認すべきこと・詰め忘れ）を、本人が話している文脈なら「続けて話すべきこと」（本人が補足・展開すべき点）を挙げる。本人の発話が見当たらなければ聞くべきこと中心でよい。単一の提案内で両方が混在してもよい。今すぐ言う/聞く価値のあるものだけ。無理に埋めず、なければ空配列。`
    : `2. questions: 会話の流れから「次に確認すべきこと」「詰め忘れている条件」を挙げる。今すぐ聞く価値のあるものだけ。無理に埋めず、なければ空配列。`;

  return `あなたはオンライン会議に同席する優秀なアシスタントです。
進行中の会議の文字起こしを読み、参加者が会議をうまく進められるよう、会議中に役立つ補足をリアルタイムで返します。

以下を提供してください:
1. topic / discussion: 今まさに話している話題と、その議論の簡潔な要約。
${questionsGuidance}
3. needsCode / codeQuery: 今の議論が自プロジェクトの実装の詳細（仕様・挙動・データ構造）に関わっており、実装を確認すると議論が正確になる場合だけ needsCode を true にし、codeQuery に確認すべき事柄を簡潔に書く。一般的な話・実装に無関係な話なら needsCode は false、codeQuery は空文字。

事前コンテキスト（アジェンダ・資料）が与えられている場合は、topic/questions の判断にも活用すること。

日本語で、簡潔に。会議の邪魔にならないよう要点だけ。`;
}

/**
 * 集中モード（メインで話すとき）は情報過多を避けるため、WEB/CODEとも件数を生成段階で
 * 最大2件に絞る。通常モード（ナビゲーター）は現状どおり0〜4件。
 */
function focusModeGuidance(focusMode: boolean): string {
  return focusMode
    ? "今は集中モードです。最も重要なものだけを最大2件に厳選してください（無ければ0件）。"
    : "0〜4個。";
}

function buildWebSystemPrompt(focusMode: boolean): string {
  return `あなたはオンライン会議に同席する優秀なアシスタントです。
進行中の会議の文字起こしを読み、参加者の議論を深める背景知識をWeb検索で調べて返します。

web: 会話に登場した専門用語・技術・製品・固有名詞のうち、背景知識があると議論が深まるものをWeb検索で調べて簡潔に補足する。一般常識レベルのものは含めない。${focusModeGuidance(focusMode)}各項目に参照元URLを可能な限り添える。

日本語で、簡潔に。会議の邪魔にならないよう要点だけ。`;
}

function buildCodeSystemPrompt(focusMode: boolean): string {
  return `あなたは会議に同席するアシスタントです。
Read/Grep/Globで自プロジェクトの実装を調べ、会議で話している仕様・挙動を実装の事実で裏付けます。

code: 推測で埋めず、実際に読んだ内容だけを書く。各項目に参照位置(ファイル:行)を可能なら添える。${focusModeGuidance(focusMode)}

日本語で、簡潔に。会議の邪魔にならないよう要点だけ。`;
}

/** claude -p に渡す構造化出力スキーマ（事前コンテキスト要約用）。長い資料を圧縮してmeetingContextとして保持する */
const CONTEXT_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "会議中の提案生成に使う事前コンテキスト。アジェンダ・論点・決定事項・関係者・専門用語を箇条書き中心に圧縮",
    },
  },
  required: ["summary"],
  additionalProperties: false,
} as const;

/** 事前コンテキスト要約用のシステムプロンプト（既存 buildSummarySystemPrompt と同じトーン） */
const CONTEXT_SUMMARY_SYSTEM_PROMPT = `あなたはオンライン会議に同席する優秀なアシスタントです。
与えられたアジェンダ・議題資料を、会議中リアルタイム提案の事前コンテキストとして参照しやすい箇条書き中心の形に圧縮してください。

論点・決定事項・関係者・固有名詞/専門用語・前提・数値は残し、冗長な地の文・重複は削ってください。
日本語で簡潔に。`;

/** 事前コンテキストがこの文字数を超えたら要約する。会議開始前/直後の初回1回だけ走るため低めに設定する */
export const CONTEXT_SUMMARIZE_THRESHOLD = 2000;

/**
 * 会議ごとの事前コンテキスト（アジェンダ・資料）が長い場合に、claude -p で一度だけ要約する。
 * generateSuggestion と同様、呼び出し前に claudeCwd を用意する。
 */
export async function summarizeMeetingContext(raw: string): Promise<string> {
  await mkdir(config.claudeCwd, { recursive: true });
  const task: ClaudeTask = {
    prompt: raw,
    systemPrompt: CONTEXT_SUMMARY_SYSTEM_PROMPT,
    schema: CONTEXT_SUMMARY_SCHEMA,
    allowedTools: [],
    model: config.model,
    timeoutMs: config.claudeTimeoutSec * 1000,
  };
  const result = await runClaude(task);
  const o = result.structured as Record<string, unknown> | undefined;
  if (!o || typeof o.summary !== "string") {
    throw new Error("claude returned no structured_output for context summary");
  }
  return o.summary;
}

export interface SuggestResult {
  suggestion: Suggestion;
  /** 生成全体の壁時計時間(ms)。runClaudeの自己申告duration_msではなくDate.now()差分。C逐次区間・タイムアウトを含めるため */
  durationMs: number;
  costUsd: number;
}

/** claude -p の --output-format json が返すトップレベル構造（必要な部分だけ） */
interface ClaudeJsonResult {
  is_error: boolean;
  result: string;
  duration_ms: number;
  total_cost_usd: number;
  structured_output?: unknown;
}

/** claude -p 1回の呼び出しを表すタスク定義。A/B/Cで差し替え可能な部分だけを引数化する */
interface ClaudeTask {
  prompt: string;
  systemPrompt: string;
  schema: object;
  /** 空配列なら --allowedTools を付けない（ツールなし=速い） */
  allowedTools: string[];
  /** 将来 A/B/C 別モデル化の拡張点（今は全て config.model） */
  model: string;
  timeoutMs: number;
  /** cwd外の参照を許可する追加ディレクトリ（--add-dir）。Cで自プロジェクトを読ませるのに使う */
  addDirs?: string[];
}

interface ClaudeRunResult {
  structured: unknown;
  durationMs: number;
  costUsd: number;
}

/** B/Cが未実行・失敗したときのダミー結果（cost/duration 0）。A/B/Cを対称に扱うための共通フォールバック */
const EMPTY_RESULT: ClaudeRunResult = { structured: undefined, durationMs: 0, costUsd: 0 };

/**
 * 直近の発話と（あれば）前回の提案をClaudeに渡し、新しい提案を生成する。
 * 前回提案を渡すことで、話題が変わっていなければ既存内容を維持し、
 * 変化があった部分だけ更新するよう促す（miyagawa版のUPDATED/unchangedに相当）。
 *
 * 内部では性質の違う複数プロセスに分割して実行する:
 *   A（速い・ツールなし）: topic + discussion + questions + needsCode判定
 *   B（遅い・WebSearchあり）: web(WebNote[]) のみ。Aと並行実行
 *   C（遅い・Read/Grep/Globあり）: code(CodeNote[]) のみ。Aの判定(needsCode)に依存するため逐次実行
 * B/Cが失敗・未実行でもAだけで提案を返す（会議中に全滅しないため）。
 */
export async function generateSuggestion(
  cues: Cue[],
  previous: Suggestion | null,
): Promise<SuggestResult> {
  await mkdir(config.claudeCwd, { recursive: true });
  const startedAt = Date.now();

  const recent = cues.slice(-config.recentCueLimit);
  const transcript = recent.map((c) => `${c.speaker}: ${c.text}`).join("\n");

  // previousの一部だけを抜粋してプロンプトに埋め込む（A/B/Cそれぞれ入力を減らして速くする）。
  // previousが無ければ抜粋も無し
  const prevSection = (label: string, data: unknown): string =>
    previous
      ? `\n\n【前回の${label}】話題が続いているなら維持し、変化があった点だけ更新してください:\n${JSON.stringify(
          data,
          null,
          2,
        )}`
      : "";
  const prevSummary = previous && {
    topic: previous.topic,
    discussion: previous.discussion,
    questions: previous.questions,
  };
  const prevWeb = previous && { web: previous.web };

  // 会議ごとに事前登録されたアジェンダ・議題資料（非永続化・オーバーレイから都度設定）。
  // A（要約）とC（コード参照）のプロンプト冒頭にだけ埋め込む。B（Web検索）には渡さない。
  // 事前コンテキストは文脈の前提となるため、文字起こしより前（プロンプト冒頭）に置く。
  const meetingContextSection = config.meetingContext
    ? `【この会議の事前コンテキスト（アジェンダ・資料）】\n${config.meetingContext}\n\n`
    : "";

  const baseTask = { model: config.model } as const;
  const summaryTask: ClaudeTask = {
    ...baseTask,
    prompt: `${meetingContextSection}以下は進行中の会議の直近の文字起こしです。\n\n${transcript}${prevSection("提案", prevSummary)}`,
    systemPrompt: buildSummarySystemPrompt(config.myName),
    schema: SUMMARY_SCHEMA,
    allowedTools: [],
    timeoutMs: config.claudeTimeoutSec * 1000,
  };
  const webTask: ClaudeTask = {
    ...baseTask,
    prompt: `以下は進行中の会議の直近の文字起こしです。\n\n${transcript}${prevSection("補足", prevWeb)}`,
    systemPrompt: buildWebSystemPrompt(config.focusMode),
    schema: buildWebSchema(config.focusMode),
    allowedTools: ["WebSearch"],
    timeoutMs: config.claudeWebTimeoutSec * 1000,
  };

  const [summaryOutcome, webOutcome] = await Promise.allSettled([
    runClaude(summaryTask),
    runClaude(webTask),
  ]);

  // A（要約）が失敗したら提案自体を出せないためthrowする（従来の全体失敗と同じ挙動）
  if (summaryOutcome.status === "rejected") {
    throw summaryOutcome.reason;
  }
  const summaryRaw = summaryOutcome.value.structured;
  const summary = toSummary(summaryRaw);

  // B（web）が失敗してもAだけで続行する（会議中に全滅しないための方針）。
  // 空配列・cost/duration 0 のダミー結果にフォールバックし、以降はA/B/Cを対称に扱う
  let webResult: ClaudeRunResult;
  if (webOutcome.status === "fulfilled") {
    webResult = webOutcome.value;
  } else {
    console.warn("web task failed:", webOutcome.reason);
    webResult = EMPTY_RESULT;
  }
  const web = toWeb(webResult.structured);

  // C（コード参照）はAの判定(needsCode)に依存する逐次実行。
  // needsCodeがtrueかつprojectDirが設定済みのときだけ発火する（LLM判断駆動、無駄な探索を避ける）
  const { needsCode, codeQuery } = toCodeDecision(summaryRaw);
  let codeResult: ClaudeRunResult = EMPTY_RESULT;
  if (needsCode && config.projectDir) {
    const codeTask: ClaudeTask = {
      ...baseTask,
      prompt: `${meetingContextSection}以下は進行中の会議の直近の文字起こしです。\n\n${transcript}\n\n【実装で確認すべきこと】\n${codeQuery}${prevSection("実装確認", previous && { code: previous.code })}`,
      systemPrompt: buildCodeSystemPrompt(config.focusMode),
      schema: buildCodeSchema(config.focusMode),
      allowedTools: ["Read", "Grep", "Glob"],
      timeoutMs: config.claudeCodeTimeoutSec * 1000,
      addDirs: [config.projectDir],
    };
    try {
      codeResult = await runClaude(codeTask);
    } catch (err) {
      console.warn("code task failed:", err);
    }
  }
  const code = toCode(codeResult.structured);

  return {
    suggestion: { ...summary, web, code },
    durationMs: Date.now() - startedAt,
    costUsd: summaryOutcome.value.costUsd + webResult.costUsd + codeResult.costUsd,
  };
}

/**
 * 外部プロセス(claude)の出力を信頼しきらず、要約部分をSuggestionの形に正規化する。
 * CLIのバージョン変化や出力仕様変更で形が崩れても、下流(renderer)が壊れないようにする。
 * Aは必須のため、raw が無ければ throw する。
 * needsCode/codeQuery はSuggestion型に含めない（内部の制御フローだけで使う）ため、ここでは読まない。
 */
function toSummary(raw: unknown): Omit<Suggestion, "web" | "code"> {
  if (!raw || typeof raw !== "object") {
    throw new Error("claude returned no structured_output");
  }
  const o = raw as Record<string, unknown>;
  return {
    topic: typeof o.topic === "string" ? o.topic : "",
    discussion: typeof o.discussion === "string" ? o.discussion : "",
    questions: Array.isArray(o.questions)
      ? o.questions.filter((q): q is string => typeof q === "string")
      : [],
  };
}

/** Aの生structured_outputから、C発火要否の判定フラグだけを別途読み取る */
function toCodeDecision(raw: unknown): { needsCode: boolean; codeQuery: string } {
  if (!raw || typeof raw !== "object") return { needsCode: false, codeQuery: "" };
  const o = raw as Record<string, unknown>;
  return {
    needsCode: o.needsCode === true,
    codeQuery: typeof o.codeQuery === "string" ? o.codeQuery : "",
  };
}

/**
 * 外部プロセス(claude)の出力を信頼しきらず、web部分を正規化する。
 * Bは欠けても致命的でないため、raw が無ければ空配列を返す。
 */
function toWeb(raw: unknown): WebNote[] {
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  return Array.isArray(o.web)
    ? o.web
        .filter((w): w is Record<string, unknown> => !!w && typeof w === "object")
        .map((w) => ({
          title: typeof w.title === "string" ? w.title : "",
          detail: typeof w.detail === "string" ? w.detail : "",
          ...(isHttpsUrl(w.url) ? { url: w.url } : {}),
        }))
        .filter((w) => w.title || w.detail)
    : [];
}

/**
 * 外部プロセス(claude)の出力を信頼しきらず、code部分を正規化する。
 * Cは欠けても致命的でないため、raw が無ければ空配列を返す。
 * projectDir が GitHub リポジトリで ref が解決できたときだけ、ref を GitHub blob URL にして付与する。
 */
function toCode(raw: unknown): CodeNote[] {
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.code)) return [];

  // resolveGitRepo は同一会議（同一 projectDir）中はキャッシュを返すため、
  // 呼ぶたびに git を同期実行するわけではない
  const projectDir = config.projectDir;
  const repo = projectDir ? resolveGitRepo(projectDir) : null;

  // isRefStale は repo.ref（同一呼び出し内で不変）しか見ないため、code アイテムごとに
  // 呼び直さず一度だけ計算する。isPathDirty は item ごとに path が変わるため、
  // 同じ path が複数 code アイテムに現れても git status の同期実行が1回で済むようメモ化する。
  const isStale = repo && projectDir ? isRefStale(projectDir, repo.ref) : false;
  const dirtyCache = new Map<string, boolean>();
  const isDirtyMemoized = (dir: string, path: string): boolean => {
    const cached = dirtyCache.get(path);
    if (cached !== undefined) return cached;
    const result = isPathDirty(dir, path);
    dirtyCache.set(path, result);
    return result;
  };

  return o.code
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => {
      const ref = typeof c.ref === "string" && c.ref ? c.ref : undefined;
      const url =
        ref && repo && projectDir
          ? buildGithubRefUrl(ref, repo, projectDir, isDirtyMemoized, () => isStale)
          : null;
      return {
        title: typeof c.title === "string" ? c.title : "",
        detail: typeof c.detail === "string" ? c.detail : "",
        ...(ref ? { ref } : {}),
        ...(url ? { url } : {}),
      };
    })
    .filter((c) => c.title || c.detail);
}

/**
 * claude CLI の実行パスを解決してキャッシュする。
 * Finder/Dockから起動するとログインシェルのPATHを継承しないため、
 * config.claudeBin > `which claude` > よくあるインストール先 の順で探す。
 */
let cachedClaudeBin: string | undefined;
function resolveClaudeBin(): string {
  if (cachedClaudeBin) return cachedClaudeBin;
  if (config.claudeBin) return (cachedClaudeBin = config.claudeBin);

  try {
    const found = execFileSync("/usr/bin/which", ["claude"], { encoding: "utf8" }).trim();
    if (found) return (cachedClaudeBin = found);
  } catch {
    // PATHに無い（GUI起動時など）。次のフォールバックへ
  }

  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    join(homedir(), ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return (cachedClaudeBin = c);
  }

  // 見つからなくても spawn に "claude" を渡して error イベントで拾わせる
  return (cachedClaudeBin = "claude");
}

/** claude -p をタスク定義に従いサブプロセスで実行し、構造化出力・所要時間・コストを返す */
function runClaude(task: ClaudeTask): Promise<ClaudeRunResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      task.prompt,
      "--model",
      task.model,
      "--output-format",
      "json",
      // user/project/local の設定を全無効化（CLAUDE.md/hooks/MCPの影響排除・警告抑止）
      "--setting-sources",
      "",
    ];
    if (task.addDirs?.length) {
      // 空cwd（claudeCwd）を維持したまま、Cで自プロジェクトをRead/Grep/Glob参照させる。
      // --setting-sources "" があるためaddDirsが実プロジェクトでもCLAUDE.md/hooks/MCPは読み込まれない
      args.push("--add-dir", ...task.addDirs);
    }
    if (task.allowedTools.length > 0) {
      args.push("--allowedTools", ...task.allowedTools);
    }
    args.push(
      "--append-system-prompt",
      task.systemPrompt,
      "--json-schema",
      JSON.stringify(task.schema),
    );

    const child = spawn(resolveClaudeBin(), args, {
      cwd: config.claudeCwd, // 空ディレクトリ。CLAUDE.md自動探索を回避
      stdio: ["ignore", "pipe", "pipe"], // stdinはignore（stdin待ちを防ぐ）
    });

    let stdout = "";
    let stderr = "";
    // UTF-8でデコード。マルチバイト(日本語)がチャンク境界で分割されても化けない
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude timed out after ${task.timeoutMs}ms`));
    }, task.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      let parsed: ClaudeJsonResult;
      try {
        parsed = JSON.parse(stdout) as ClaudeJsonResult;
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (parsed.is_error) {
        reject(new Error(`claude returned error: ${parsed.result ?? "unknown"}`));
        return;
      }
      resolve({
        structured: parsed.structured_output,
        durationMs: parsed.duration_ms,
        costUsd: parsed.total_cost_usd,
      });
    });
  });
}
