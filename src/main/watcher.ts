import { EventEmitter } from "node:events";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { Cue } from "../shared/types";
import { config } from "./config";

/**
 * zoom-transcripts ディレクトリを監視し、「最新のjsonl = 進行中のミーティング」を
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

export class TranscriptWatcher extends EventEmitter {
  private dirWatcher?: FSWatcher;
  private fileWatcher?: FSWatcher;
  private currentFile?: string;

  async start(): Promise<void> {
    // 新しいミーティング（より新しいjsonl）の出現を監視する
    this.dirWatcher = chokidar.watch(config.transcriptDir, {
      depth: 0,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    this.dirWatcher.on("add", (path) => {
      if (!path.endsWith("-transcript.jsonl")) return;
      // 追加されたファイルが現在のより新しければ切り替える
      if (!this.currentFile || path > this.currentFile) {
        void this.switchTo(path);
      }
    });

    // watcherの初期スキャン完了後に最新ファイルを拾う。
    // findLatestとwatch開始の順序を「watch開始 → ready → findLatest」にすることで、
    // その隙間に作られたファイルを取りこぼす窓をなくす（readyまでのadd/changeはバッファされる）。
    await new Promise<void>((resolve) => this.dirWatcher?.once("ready", () => resolve()));
    const latest = await this.findLatest();
    if (latest && latest !== this.currentFile) {
      await this.switchTo(latest);
    } else if (!latest && !this.currentFile) {
      this.emit("no-meeting");
    }
  }

  /** 監視対象を指定ファイルに切り替え、内容更新を監視する */
  private async switchTo(file: string): Promise<void> {
    this.currentFile = file;
    await this.fileWatcher?.close();

    this.emit("meeting", file);
    await this.emitCues(file); // 初回読み込み

    this.fileWatcher = chokidar.watch(file, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    this.fileWatcher.on("change", () => void this.emitCues(file));
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

  /** transcriptDir内で最も新しい *-transcript.jsonl のフルパスを返す */
  private async findLatest(): Promise<string | undefined> {
    let entries: string[];
    try {
      entries = await readdir(config.transcriptDir);
    } catch {
      return undefined;
    }
    const files = entries.filter((n) => n.endsWith("-transcript.jsonl")).sort();
    if (files.length === 0) return undefined;

    // ファイル名でソート済みだが、念のためmtimeでも最新を選ぶ
    let latest: { path: string; mtime: number } | undefined;
    for (const name of files) {
      const path = join(config.transcriptDir, name);
      const s = await stat(path);
      if (!latest || s.mtimeMs > latest.mtime) latest = { path, mtime: s.mtimeMs };
    }
    return latest?.path;
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
