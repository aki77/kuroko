import { EventEmitter } from "node:events";
import { basename } from "node:path";
import type {
  Cue,
  Status,
  Suggestion,
  SuggestionPartUpdate,
  SuggestionUpdate,
} from "../shared/types.js";
import { config } from "./config.js";
import { generateSuggestion } from "./suggester.js";
import { TranscriptWatcher } from "./watcher.js";

/**
 * watcher → トリガー判定 → suggester → 提案更新 を統括する。
 * レンダラに 'suggestion' / 'status' イベントを流す。
 *
 * トリガー方針（要件: 自動＋発話量）:
 *   前回の提案生成時点の発話数から triggerCueCount 件以上増えたら、
 *   debounce後に次の提案を生成する。生成中に追記が来ても多重起動しない。
 */
export declare interface Orchestrator {
  on(event: "suggestion", listener: (u: SuggestionUpdate) => void): this;
  on(event: "suggestion-part", listener: (u: SuggestionPartUpdate) => void): this;
  on(event: "status", listener: (s: Status) => void): this;
}

export class Orchestrator extends EventEmitter {
  private watcher = new TranscriptWatcher();
  private currentFile?: string;
  private latestCues: Cue[] = [];
  private previous: Suggestion | null = null;
  private cueCountAtLastRun = 0;
  private generating = false;
  /** 生成中のrunが対象としている会議ファイル。完了時に現在の会議と一致するか検証する */
  private runningForFile?: string;
  /** 生成中に手動トリガーが来たら覚えておき、完了後に実行する */
  private pendingTrigger = false;
  private debounceTimer?: NodeJS.Timeout;
  private cumulativeCostUsd = 0;

  async start(): Promise<void> {
    this.bindWatcher();
    await this.watcher.start();
  }

  /** 現在の this.watcher にリスナを登録する。watcher差し替え時にも再利用する */
  private bindWatcher(): void {
    this.watcher.on("no-meeting", () => this.emit("status", { kind: "no-meeting" }));

    this.watcher.on("meeting", (file) => {
      // 新しいミーティングに切り替わったら状態をリセット。
      // 生成中のrunがあっても runningForFile と不一致になり結果は破棄される。
      this.currentFile = file;
      this.previous = null;
      this.cueCountAtLastRun = 0;
      this.latestCues = [];
      this.pendingTrigger = false;
      this.emit("status", { kind: "idle" });
    });

    this.watcher.on("cues", (file, cues) => {
      if (file !== this.currentFile) return;
      this.latestCues = cues;
      this.scheduleMaybeRun();
    });
  }

  /**
   * transcriptDir 変更に伴い watcher を作り直す。
   * 旧watcherを止め、会議状態を初期化してから新しい TranscriptWatcher を張り直す。
   * cumulativeCostUsd は会議跨ぎで累積する参考値なのでリセットしない（既存踏襲）。
   */
  async restartWatcher(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    await this.watcher.stop();

    // "meeting" ハンドラ相当の初期化（新watcherがまだ何も検知していない状態に戻す）
    this.currentFile = undefined;
    this.previous = null;
    this.cueCountAtLastRun = 0;
    this.latestCues = [];
    this.pendingTrigger = false;

    this.watcher = new TranscriptWatcher();
    this.bindWatcher();
    await this.watcher.start();
  }

  /** 手動トリガー（キー/ボタンから即生成） */
  triggerNow(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.generating) {
      // 生成中は破棄せず予約し、完了後に確実に再生成する
      this.pendingTrigger = true;
      return;
    }
    void this.run();
  }

  private scheduleMaybeRun(): void {
    const pending = this.latestCues.length - this.cueCountAtLastRun;
    if (pending < config.triggerCueCount) {
      this.emit("status", {
        kind: "waiting",
        pendingCues: Math.max(0, pending),
        needed: config.triggerCueCount,
      });
      return;
    }
    // 閾値到達。連続追記をまとめるためデバウンスしてから生成
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.run(), config.debounceMs);
  }

  private async run(): Promise<void> {
    if (this.generating) return; // 生成中は多重起動しない
    if (this.latestCues.length === 0 || !this.currentFile) return;

    const file = this.currentFile; // このrunが対象とする会議を固定する
    this.generating = true;
    this.runningForFile = file;
    this.cueCountAtLastRun = this.latestCues.length;
    this.emit("status", { kind: "querying" });

    try {
      const { suggestion, durationMs, costUsd } = await generateSuggestion(
        this.latestCues,
        this.previous,
        (part) => {
          if (this.currentFile !== file) return; // 会議切替済みの古い部分は破棄
          this.emit("suggestion-part", { part, meetingFile: basename(file) });
        },
      );

      // 生成中に会議が切り替わっていたら、この提案は古いので破棄する
      if (this.currentFile !== file) return;

      this.previous = suggestion;
      this.cumulativeCostUsd += costUsd;

      const update: SuggestionUpdate = {
        suggestion,
        meetingFile: basename(file),
        updatedAt: new Date().toISOString(),
        durationMs,
        cumulativeCostUsd: this.cumulativeCostUsd,
      };
      this.emit("suggestion", update);
      this.emit("status", { kind: "idle" });
    } catch (err) {
      if (this.currentFile !== file) return; // 会議が変わっていればエラーも無視
      this.emit("status", {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.generating = false;
      this.runningForFile = undefined;
      if (this.pendingTrigger) {
        // 生成中に来た手動トリガーを消化する
        this.pendingTrigger = false;
        void this.run();
      } else {
        // 生成中にたまった分が閾値を超えていれば続けて生成
        this.scheduleMaybeRun();
      }
    }
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    await this.watcher.stop();
  }
}
