import { EventEmitter } from "node:events";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { Cue } from "../shared/types.js";
import { config } from "./config.js";
import { isStaleLatest } from "./watcher-stale.js";

/**
 * 文字起こし用ディレクトリ（config.transcriptDir）を監視し、「最新のjsonl = 進行中のミーティング」を
 * 追跡する。ファイル内容が更新されるたびに、seqごとに最新revisionを採用した
 * 確定発話リストを 'cues' イベントで通知する。
 *
 * jsonlの特性:
 * - 1行1JSON。{seq, speaker, text, revision, start, end}
 * - 同一seqが revision を上げながら複数回追記される（訂正されていく）
 *   → seqごとに最大revisionの行だけを採用する
 * - ファイル名 YYYY-MM-DDThhmmss-transcript.jsonl で新しいほど新しいミーティング
 */
export declare interface TranscriptWatcher {
  on(event: "cues", listener: (file: string, cues: Cue[]) => void): this;
  on(event: "meeting", listener: (file: string) => void): this;
  on(event: "no-meeting", listener: () => void): this;
}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: EventEmitterのonを型付けするための意図的なTypedEventEmitterパターン
export class TranscriptWatcher extends EventEmitter {
  private dirWatcher?: FSWatcher;
  private fileWatcher?: FSWatcher;
  private currentFile?: string;
  private currentMtimeMs = -Infinity;

  async start(): Promise<void> {
    // 新しいミーティング（より新しいjsonl）の出現を監視する
    this.dirWatcher = chokidar.watch(config.transcriptDir, {
      depth: 0,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    this.dirWatcher.on("add", (path, s) => {
      if (!path.endsWith("-transcript.jsonl")) return;
      // 追加されたファイルが現在のより新しければ切り替える（同一/古いファイルへはswitchTo側のガードで戻らない）
      void this.switchTo(path, s?.mtimeMs ?? Date.now());
    });

    // watcherの初期スキャン完了後に最新ファイルを拾う。
    // findLatestとwatch開始の順序を「watch開始 → ready → findLatest」にすることで、
    // その隙間に作られたファイルを取りこぼす窓をなくす（readyまでのadd/changeはバッファされる）。
    await new Promise<void>((resolve) =>
      this.dirWatcher?.once("ready", () => resolve()),
    );
    const latest = await this.findLatest();
    if (!latest) {
      if (!this.currentFile) this.emit("no-meeting");
      return;
    }
    if (
      isStaleLatest(latest.mtimeMs, Date.now(), config.meetingStaleMin * 60_000)
    ) {
      // 古い最新ファイル: 会議にはしないが、追記されたら会議開始できるよう監視する
      if (!this.currentFile) {
        this.emit("no-meeting");
        this.watchStale(latest.path, latest.mtimeMs);
      }
    } else if (latest.path !== this.currentFile) {
      await this.switchTo(latest.path, latest.mtimeMs);
    }
  }

  /** 監視対象を指定ファイルに切り替え、内容更新を監視する */
  private async switchTo(file: string, mtimeMs: number): Promise<void> {
    if (mtimeMs <= this.currentMtimeMs) return; // より古い/同一へは戻らない
    this.currentFile = file;
    this.currentMtimeMs = mtimeMs;

    this.emit("meeting", file);
    await this.emitCues(file); // 初回読み込み

    this.watchFile(file, () => void this.emitCues(file));
  }

  /**
   * 古い候補ファイル（起動時点でstaleだった最新jsonl）の追記だけを監視する。
   * 会議としては採用せず（meeting/cuesを出さない）、changeが来たらswitchToに昇格して会議開始する。
   * switchToと同じ this.fileWatcher スロットを使うため二重監視にならない。
   */
  private watchStale(file: string, mtimeMs: number): void {
    this.watchFile(file, () => void this.switchTo(file, mtimeMs));
  }

  /** 単一ファイルのchokidar監視を張り直す（既存のfileWatcherは閉じてから差し替える） */
  private watchFile(file: string, onChange: () => void): void {
    void this.fileWatcher?.close();
    this.fileWatcher = chokidar.watch(file, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    this.fileWatcher.on("change", onChange);
  }

  private async emitCues(file: string): Promise<void> {
    try {
      const cues = await parseTranscript(file);
      this.emit("cues", file, cues);
    } catch (err) {
      // 読み込み途中の追記と競合することがあるが、次のchangeで回復するので握りつぶす
      console.error("[watcher] parse error:", err);
    }
  }

  /** transcriptDir内で最も新しい *-transcript.jsonl のパスとmtimeを返す（stale判定は呼び出し側の責務） */
  private async findLatest(): Promise<
    { path: string; mtimeMs: number } | undefined
  > {
    let entries: string[];
    try {
      entries = await readdir(config.transcriptDir);
    } catch {
      return undefined;
    }
    const files = entries.filter((n) => n.endsWith("-transcript.jsonl")).sort();
    if (files.length === 0) return undefined;

    // ファイル名でソート済みだが、念のためmtimeでも最新を選ぶ
    let latest: { path: string; mtimeMs: number } | undefined;
    for (const name of files) {
      const path = join(config.transcriptDir, name);
      const s = await stat(path);
      if (!latest || s.mtimeMs > latest.mtimeMs)
        latest = { path, mtimeMs: s.mtimeMs };
    }
    return latest;
  }

  async stop(): Promise<void> {
    await this.dirWatcher?.close();
    await this.fileWatcher?.close();
  }
}

/**
 * jsonlをパースし、seqごとに最新revisionを採用した確定発話をseq昇順で返す。
 * 破損した行（追記途中の不完全JSON）はスキップする。
 */
export async function parseTranscript(file: string): Promise<Cue[]> {
  const raw = await readFile(file, "utf8");
  const bySeq = new Map<number, Cue>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: {
      seq?: number;
      speaker?: string;
      text?: string;
      revision?: number;
    };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // 追記途中の不完全な行
    }
    if (typeof obj.seq !== "number" || typeof obj.text !== "string") continue;

    const revision = typeof obj.revision === "number" ? obj.revision : 1;
    const existing = bySeq.get(obj.seq);
    if (!existing || revision >= existing.revision) {
      bySeq.set(obj.seq, {
        seq: obj.seq,
        speaker: obj.speaker ?? "?",
        text: obj.text,
        revision,
      });
    }
  }

  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
