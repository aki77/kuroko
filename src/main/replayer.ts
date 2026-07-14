import { appendFile, readFile, unlink, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

/**
 * 【開発用】過去の文字起こしjsonlを実タイムスタンプに沿って再生し、
 * transcriptDir内に仮の *-transcript.jsonl を1行ずつ追記していく。
 *
 * watcher.tsは「transcriptDir内でファイル名が最も大きい *-transcript.jsonl」を
 * 進行中の会議として追跡するだけなので、ここでは各行を一切加工せず
 * そのまま追記すれば下流（watcher/orchestrator/suggester）は無改修で動く。
 */
export class Replayer {
  private timer?: NodeJS.Timeout;
  private resolveWait?: () => void;
  private stopped = false;
  private targetFile?: string;
  private playPromise?: Promise<void>;

  constructor(
    private readonly sourceFile: string,
    private readonly speed: number,
  ) {}

  async start(): Promise<void> {
    const speed = positiveOr(this.speed, 1);
    const maxGapMs = positiveOr(config.replayMaxGapMs, 30_000);

    let lines: { raw: string; start: number }[];
    try {
      lines = await this.loadLines();
    } catch (err) {
      console.error("[replayer] failed to read source file:", err);
      return;
    }

    const skip = nonNegativeIntOr(config.replaySkipLines, 0);
    const before = lines.length;
    lines = lines.slice(skip);
    if (skip > 0) {
      console.log(`[replayer] skipped first ${before - lines.length} of ${before} lines`);
    }

    if (lines.length === 0) {
      console.warn("[replayer] source file has no valid lines:", this.sourceFile);
    }

    const targetFile = join(config.transcriptDir, makeReplayFilename());
    this.targetFile = targetFile;
    await writeFile(targetFile, "");

    this.playPromise = this.playLoop(lines, speed, maxGapMs, targetFile);
  }

  private async loadLines(): Promise<{ raw: string; start: number }[]> {
    const raw = await readFile(this.sourceFile, "utf8");
    const result: { raw: string; start: number }[] = [];

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: { start?: unknown };
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue; // パース不能行はスキップ
      }
      const start = typeof obj.start === "number" ? obj.start : 0;
      result.push({ raw: trimmed, start });
    }

    return result;
  }

  private async playLoop(
    lines: { raw: string; start: number }[],
    speed: number,
    maxGapMs: number,
    targetFile: string,
  ): Promise<void> {
    let prevStart: number | undefined;

    for (const line of lines) {
      if (this.stopped) return;

      const diffSec = prevStart === undefined ? 0 : line.start - prevStart;
      prevStart = line.start;

      const delayMs = Math.min((Math.max(diffSec, 0) * 1000) / speed, maxGapMs);

      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          this.resolveWait = resolve;
          this.timer = setTimeout(resolve, delayMs);
        });
      }
      if (this.stopped) return;

      await appendFile(targetFile, `${line.raw}\n`);
    }
  }

  /** タイマー停止 + 停止フラグを立てる（stop/stopSync共通の下ごしらえ） */
  private halt(): void {
    if (this.timer) clearTimeout(this.timer);
    // clearTimeoutだけではplayLoop内で待機中のPromiseが永久にpendingのままになる
    // （resolveはsetTimeoutの発火でしか呼ばれないため）。ここで明示的に解放する。
    this.resolveWait?.();
    this.resolveWait = undefined;
    this.stopped = true;
  }

  async stop(): Promise<void> {
    this.halt();
    try {
      await this.playPromise;
    } catch {
      // playLoop内エラーは無害
    }
    if (this.targetFile) {
      try {
        await unlink(this.targetFile);
      } catch {
        // 既に無ければ無害
      }
    }
  }

  /** SIGINT/SIGTERM経路用の同期後始末。プロセス終了前に確実に仮ファイルを消す */
  stopSync(): void {
    this.halt();
    if (this.targetFile) {
      try {
        unlinkSync(this.targetFile);
      } catch {
        // 既に無ければ無害
      }
    }
  }
}

/** 正の有限数ならそのまま、そうでなければ fallback を返す（環境変数由来のNaN混入を防ぐ） */
function positiveOr(value: number, fallback: number): number {
  return value > 0 && !Number.isNaN(value) ? value : fallback;
}

/** 0以上の有限整数ならそのまま、そうでなければ fallback を返す（負値・NaN・小数の混入を防ぐ） */
function nonNegativeIntOr(value: number, fallback: number): number {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** 既存規約 YYYY-MM-DDThhmmss-transcript.jsonl に合わせたファイル名を生成する（ローカル時刻） */
function makeReplayFilename(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-transcript.jsonl`;
}
