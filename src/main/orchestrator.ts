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
import { bridgeToDebugLog, debugLog } from "./debug-log.js";
import { generateSuggestion } from "./suggester.js";
import { TranscriptWatcher } from "./watcher.js";

/**
 * Status を1行サマリに整形する（デバッグログ用）。
 * defaultを置かず全kindを列挙することで、Status に新kindを追加したときにここも
 * 更新漏れがあればコンパイルエラーで気づける（網羅性チェック）。
 */
function describeStatus(s: Status): string {
  switch (s.kind) {
    case "waiting":
      return `waiting (${s.pendingCues}/${s.needed}件)`;
    case "error":
      return `error: ${s.message}`;
    case "idle":
    case "querying":
    case "no-meeting":
    case "no-cues":
      return s.kind;
    default: {
      const exhaustive: never = s;
      return exhaustive;
    }
  }
}

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
  on(
    event: "suggestion-part",
    listener: (u: SuggestionPartUpdate) => void,
  ): this;
  on(event: "status", listener: (s: Status) => void): this;
}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: EventEmitterのonを型付けするための意図的なTypedEventEmitterパターン
export class Orchestrator extends EventEmitter {
  private watcher = new TranscriptWatcher();
  private currentFile?: string;
  private latestCues: Cue[] = [];
  /** チャット入力（オーバーレイ下部の依頼・指摘欄）の直近履歴。会議ごとのリングバッファ */
  private chatInputs: string[] = [];
  private previous: Suggestion | null = null;
  private cueCountAtLastRun = 0;
  private generating = false;
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
    this.watcher.on("no-meeting", () => this.setStatus({ kind: "no-meeting" }));

    this.watcher.on("meeting", (file) => {
      // 新しいミーティングに切り替わったら状態をリセット。
      // 生成中のrunがあっても run() 内のローカル file 変数と this.currentFile が
      // 不一致になるため、完了時にその結果は破棄される。
      this.resetMeetingState(file);
      this.setStatus({ kind: "no-cues" });
    });

    this.watcher.on("cues", (file, cues) => {
      if (file !== this.currentFile) return;
      this.latestCues = cues;
      this.scheduleMaybeRun();
    });
  }

  /**
   * status の emit とデバッグログ通知を1箇所にまとめる。両者を毎回手書きペアで
   * 散らすと対応漏れが起きやすいため、状態遷移箇所はすべてここを経由させる。
   */
  private setStatus(status: Status): void {
    this.emit("status", status);
    debugLog.push(
      "orchestrator",
      status.kind === "error" ? "error" : "info",
      "status",
      describeStatus(status),
    );
  }

  /**
   * 会議状態（発話/チャット履歴/生成結果まわり）を初期化する。
   * "meeting" ハンドラ（新しい会議への切替）と restartWatcher()（watcher作り直し）の
   * 両方から呼ばれる共通処理。フィールドを増やす際はここ1箇所を直せばよい。
   */
  private resetMeetingState(file: string | undefined): void {
    this.currentFile = file;
    this.previous = null;
    this.cueCountAtLastRun = 0;
    this.latestCues = [];
    this.chatInputs = [];
    this.pendingTrigger = false;
  }

  /**
   * transcriptDir 変更に伴い watcher を作り直す。
   * 旧watcherを止め、会議状態を初期化してから新しい TranscriptWatcher を張り直す。
   * cumulativeCostUsd は会議跨ぎで累積する参考値なのでリセットしない（既存踏襲）。
   */
  async restartWatcher(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    await this.watcher.stop();

    // 新watcherがまだ何も検知していない状態に戻す（"meeting" ハンドラ相当の初期化）
    this.resetMeetingState(undefined);

    this.watcher = new TranscriptWatcher();
    this.bindWatcher();
    await this.watcher.start();
  }

  /**
   * チャット入力（オーバーレイ下部の依頼・指摘欄）を直近履歴に積み、即座に提案を1回生成する。
   * 発話cuesと並ぶ「もう一つの入力口」として、以降の提案生成（自動含む）にも
   * chatInputsが尽きる（会議切替でクリア）まで毎回注入され続ける。
   */
  submitChatInput(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.chatInputs.push(t);
    // slice(-N)は配列長がN以下でも安全（元と同じ内容を返す）ため上限チェックのifは不要
    this.chatInputs = this.chatInputs.slice(-config.chatInputLimit);
    debugLog.push("orchestrator", "info", "chat-input", `参加者入力: ${t}`);
    this.triggerNow(); // 既存の手動トリガー経路を再利用（生成中なら pendingTrigger で予約される）
  }

  /** 手動トリガー（キー/ボタンから即生成） */
  triggerNow(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.generating) {
      // 生成中は破棄せず予約し、完了後に確実に再生成する
      this.pendingTrigger = true;
      debugLog.push(
        "orchestrator",
        "info",
        "trigger",
        "手動トリガー（生成中のため予約）",
      );
      return;
    }
    debugLog.push("orchestrator", "info", "trigger", "手動トリガー");
    void this.run();
  }

  private scheduleMaybeRun(): void {
    // 発話がまだ1件も届いていなければ no-cues のまま（waitingへ落とさない）。
    // watcher が新規会議で発火する初回の空cuesイベントで no-cues が waiting に
    // 上書きされ、チャット入力欄が誤って有効化されるのを防ぐ。
    if (this.latestCues.length === 0) {
      this.setStatus({ kind: "no-cues" });
      return;
    }
    const pending = this.latestCues.length - this.cueCountAtLastRun;
    if (pending < config.triggerCueCount) {
      this.setStatus({
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
    this.cueCountAtLastRun = this.latestCues.length;
    this.setStatus({ kind: "querying" });
    debugLog.push(
      "orchestrator",
      "info",
      "run-start",
      `対象=${basename(file)}, cue=${this.latestCues.length}`,
    );

    try {
      const { suggestion, durationMs, costUsd } = await generateSuggestion(
        this.latestCues,
        this.previous,
        this.chatInputs,
        (part) => {
          if (this.currentFile !== file) return; // 会議切替済みの古い部分は破棄
          this.emit("suggestion-part", { part, meetingFile: basename(file) });
        },
        bridgeToDebugLog,
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
      this.setStatus({ kind: "idle" });
    } catch (err) {
      if (this.currentFile !== file) return; // 会議が変わっていればエラーも無視
      this.setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.generating = false;
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
