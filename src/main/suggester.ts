import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Cue, Suggestion } from "../shared/types";
import { config } from "./config";

/** claude -p に渡す構造化出力スキーマ（Suggestion型と一致させる） */
const SUGGESTION_SCHEMA = {
  type: "object",
  properties: {
    topic: { type: "string", description: "今まさに話している話題の短い見出し" },
    discussion: { type: "string", description: "今の議論の2〜3文の要約" },
    questions: {
      type: "array",
      items: { type: "string" },
      description: "次に確認すべき質問・確認漏れ（1〜4個、なければ空配列）",
    },
    web: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
        },
        required: ["title", "detail"],
        additionalProperties: false,
      },
      description: "会話に出た用語・技術・固有名詞をWeb検索で補った背景知識（0〜4個）",
    },
  },
  required: ["topic", "discussion", "questions", "web"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `あなたはオンライン会議に同席する優秀なアシスタントです。
進行中の会議の文字起こしを読み、参加者が会議をうまく進められるよう、会議中に役立つ補足をリアルタイムで返します。

以下の3点を提供してください:
1. topic / discussion: 今まさに話している話題と、その議論の簡潔な要約。
2. questions: 会話の流れから「次に確認すべきこと」「詰め忘れている条件」を挙げる。今すぐ聞く価値のあるものだけ。無理に埋めず、なければ空配列。
3. web: 会話に登場した専門用語・技術・製品・固有名詞のうち、背景知識があると議論が深まるものをWeb検索で調べて簡潔に補足する。一般常識レベルのものは含めない。0〜4個。

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
  structured_output?: Suggestion;
}

/**
 * 直近の発話と（あれば）前回の提案をClaudeに渡し、新しい提案を生成する。
 * 前回提案を渡すことで、話題が変わっていなければ既存内容を維持し、
 * 変化があった部分だけ更新するよう促す（miyagawa版のUPDATED/unchangedに相当）。
 */
export async function generateSuggestion(
  cues: Cue[],
  previous: Suggestion | null,
): Promise<SuggestResult> {
  await mkdir(config.claudeCwd, { recursive: true });

  const recent = cues.slice(-config.recentCueLimit);
  const transcript = recent.map((c) => `${c.speaker}: ${c.text}`).join("\n");

  const prevSection = previous
    ? `\n\n【前回の提案】話題が続いているなら維持し、変化があった点だけ更新してください:\n${JSON.stringify(
        previous,
        null,
        2,
      )}`
    : "";

  const prompt = `以下は進行中の会議の直近の文字起こしです。\n\n${transcript}${prevSection}`;

  const raw = await runClaude(prompt);
  const parsed = JSON.parse(raw) as ClaudeJsonResult;

  if (parsed.is_error) {
    throw new Error(`claude returned error: ${parsed.result ?? "unknown"}`);
  }

  return {
    suggestion: toSuggestion(parsed.structured_output),
    durationMs: parsed.duration_ms,
    costUsd: parsed.total_cost_usd,
  };
}

/**
 * 外部プロセス(claude)の出力を信頼しきらず、Suggestionの形に正規化する。
 * CLIのバージョン変化や出力仕様変更で形が崩れても、下流(renderer)が壊れないようにする。
 */
function toSuggestion(raw: unknown): Suggestion {
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
    web: Array.isArray(o.web)
      ? o.web
          .filter((w): w is Record<string, unknown> => !!w && typeof w === "object")
          .map((w) => ({
            title: typeof w.title === "string" ? w.title : "",
            detail: typeof w.detail === "string" ? w.detail : "",
          }))
          .filter((w) => w.title || w.detail)
      : [],
  };
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

/** claude -p をサブプロセスで実行し、stdout(JSON文字列)を返す */
function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      prompt,
      "--model",
      config.model,
      "--output-format",
      "json",
      // user/project/local の設定を全無効化（CLAUDE.md/hooks/MCPの影響排除・警告抑止）
      "--setting-sources",
      "",
      // FROM THE WEB のためWeb検索だけ許可（他ツールは使わせない）
      "--allowedTools",
      "WebSearch",
      "--append-system-prompt",
      SYSTEM_PROMPT,
      "--json-schema",
      JSON.stringify(SUGGESTION_SCHEMA),
    ];

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
      reject(new Error(`claude timed out after ${config.claudeTimeoutMs}ms`));
    }, config.claudeTimeoutMs);

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
      resolve(stdout);
    });
  });
}
