import { EventEmitter } from "node:events";
import type { DebugEvent, OnDebug } from "../shared/types.js";

/** リングバッファの保持件数上限。デバッグ用途のため大きすぎるメモリ保持は避ける */
const MAX_EVENTS = 500;

/**
 * デバッグウィンドウ専用のイベントログ。watcher/orchestrator/suggester の要所から
 * push() されたイベントをリングバッファに保持しつつ 'event' で配信する。
 * オーバーレイの既存 Status/suggestion 経路とは完全に独立（会議中UIへの副作用ゼロ）。
 *
 * シングルトン(debugLog)として公開し、各モジュールから直接importして使う
 * （watcher/orchestrator は直接、suggester だけは純粋性維持のため onDebug コールバック注入で使う）。
 */
export declare interface DebugLog {
  on(event: "event", listener: (ev: DebugEvent) => void): this;
}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: EventEmitterのonを型付けするための意図的なTypedEventEmitterパターン
export class DebugLog extends EventEmitter {
  private buffer: DebugEvent[] = [];

  push(
    source: DebugEvent["source"],
    level: DebugEvent["level"],
    kind: string,
    message: string,
    detail?: string,
  ): void {
    const ev: DebugEvent = {
      at: new Date().toISOString(),
      source,
      level,
      kind,
      message,
      ...(detail !== undefined ? { detail } : {}),
    };
    this.buffer.push(ev);
    if (this.buffer.length > MAX_EVENTS) {
      this.buffer.splice(0, this.buffer.length - MAX_EVENTS);
    }
    this.emit("event", ev);
  }

  /** 現在のバッファ全件を返す（デバッグウィンドウを開いたときの初期流し込み用） */
  snapshot(): DebugEvent[] {
    return [...this.buffer];
  }
}

export const debugLog = new DebugLog();

/**
 * 計装側（suggester等）が受け取る OnDebug コールバックを debugLog.push へ橋渡しする共有実装。
 * caller ごとに同じワンライナーを書かず、この1本を渡す。
 */
export const bridgeToDebugLog: OnDebug = (ev) => {
  debugLog.push(ev.source, ev.level, ev.kind, ev.message, ev.detail);
};
