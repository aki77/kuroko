import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Cue, Suggestion, WebNote } from "../shared/types";
import { isHttpsUrl } from "../shared/url";
import { config } from "./config";

/** claude -p に渡す構造化出力スキーマ（A: 要約+questions のみ。WebSearchなしで速い） */
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
  },
  required: ["topic", "discussion", "questions"],
  additionalProperties: false,
} as const;

/** claude -p に渡す構造化出力スキーマ（B: web のみ。WebSearchを使うため遅い） */
const WEB_SCHEMA = {
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
      description: "会話に出た用語・技術・固有名詞をWeb検索で補った背景知識（0〜4個）",
    },
  },
  required: ["web"],
  additionalProperties: false,
} as const;

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

日本語で、簡潔に。会議の邪魔にならないよう要点だけ。`;
}

const WEB_SYSTEM_PROMPT = `あなたはオンライン会議に同席する優秀なアシスタントです。
進行中の会議の文字起こしを読み、参加者の議論を深める背景知識をWeb検索で調べて返します。

web: 会話に登場した専門用語・技術・製品・固有名詞のうち、背景知識があると議論が深まるものをWeb検索で調べて簡潔に補足する。一般常識レベルのものは含めない。0〜4個。各項目に参照元URLを可能な限り添える。

日本語で、簡潔に。会議の邪魔にならないよう要点だけ。`;

export interface SuggestResult {
  suggestion: Suggestion;
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

/** claude -p 1回の呼び出しを表すタスク定義。A/Bで差し替え可能な部分だけを引数化する */
interface ClaudeTask {
  prompt: string;
  systemPrompt: string;
  schema: object;
  /** 空配列なら --allowedTools を付けない（ツールなし=速い） */
  allowedTools: string[];
  /** 将来 A/B 別モデル化の拡張点（今は両方 config.model） */
  model: string;
  timeoutMs: number;
}

interface ClaudeRunResult {
  structured: unknown;
  durationMs: number;
  costUsd: number;
}

/**
 * 直近の発話と（あれば）前回の提案をClaudeに渡し、新しい提案を生成する。
 * 前回提案を渡すことで、話題が変わっていなければ既存内容を維持し、
 * 変化があった部分だけ更新するよう促す（miyagawa版のUPDATED/unchangedに相当）。
 *
 * 内部では性質の違う2プロセスに分割して並行実行する:
 *   A（速い・ツールなし）: topic + discussion + questions
 *   B（遅い・WebSearchあり）: web(WebNote[]) のみ
 * Bが失敗してもAだけで提案を返す（会議中に全滅しないため）。
 */
export async function generateSuggestion(
  cues: Cue[],
  previous: Suggestion | null,
): Promise<SuggestResult> {
  await mkdir(config.claudeCwd, { recursive: true });

  const recent = cues.slice(-config.recentCueLimit);
  const transcript = recent.map((c) => `${c.speaker}: ${c.text}`).join("\n");

  // previousの一部だけを抜粋してプロンプトに埋め込む（A/Bそれぞれ入力を減らして速くする）。
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

  const baseTask = { model: config.model } as const;
  const summaryTask: ClaudeTask = {
    ...baseTask,
    prompt: `以下は進行中の会議の直近の文字起こしです。\n\n${transcript}${prevSection("提案", prevSummary)}`,
    systemPrompt: buildSummarySystemPrompt(config.myName),
    schema: SUMMARY_SCHEMA,
    allowedTools: [],
    timeoutMs: config.claudeTimeoutMs,
  };
  const webTask: ClaudeTask = {
    ...baseTask,
    prompt: `以下は進行中の会議の直近の文字起こしです。\n\n${transcript}${prevSection("補足", prevWeb)}`,
    systemPrompt: WEB_SYSTEM_PROMPT,
    schema: WEB_SCHEMA,
    allowedTools: ["WebSearch"],
    timeoutMs: config.claudeWebTimeoutMs,
  };

  const [summaryOutcome, webOutcome] = await Promise.allSettled([
    runClaude(summaryTask),
    runClaude(webTask),
  ]);

  // A（要約）が失敗したら提案自体を出せないためthrowする（従来の全体失敗と同じ挙動）
  if (summaryOutcome.status === "rejected") {
    throw summaryOutcome.reason;
  }
  const summary = toSummary(summaryOutcome.value.structured);

  // B（web）が失敗してもAだけで続行する（会議中に全滅しないための方針）。
  // 空配列・cost/duration 0 のダミー結果にフォールバックし、以降はA/Bを対称に扱う
  let webResult: ClaudeRunResult;
  if (webOutcome.status === "fulfilled") {
    webResult = webOutcome.value;
  } else {
    console.warn("web task failed:", webOutcome.reason);
    webResult = { structured: undefined, durationMs: 0, costUsd: 0 };
  }
  const web = toWeb(webResult.structured);

  return {
    suggestion: { ...summary, web },
    durationMs: Math.max(summaryOutcome.value.durationMs, webResult.durationMs),
    costUsd: summaryOutcome.value.costUsd + webResult.costUsd,
  };
}

/**
 * 外部プロセス(claude)の出力を信頼しきらず、要約部分をSuggestionの形に正規化する。
 * CLIのバージョン変化や出力仕様変更で形が崩れても、下流(renderer)が壊れないようにする。
 * Aは必須のため、raw が無ければ throw する。
 */
function toSummary(raw: unknown): Omit<Suggestion, "web"> {
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
