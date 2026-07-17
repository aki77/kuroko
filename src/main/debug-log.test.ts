import assert from "node:assert/strict";
import { test } from "node:test";
import { DebugLog } from "./debug-log.ts";

test("push: バッファに積まれ snapshot で返る", () => {
  const log = new DebugLog();
  log.push("watcher", "info", "meeting", "会議切替: foo.jsonl");
  const snap = log.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].source, "watcher");
  assert.equal(snap[0].level, "info");
  assert.equal(snap[0].kind, "meeting");
  assert.equal(snap[0].message, "会議切替: foo.jsonl");
  assert.equal(typeof snap[0].at, "string");
});

test("push: detail省略時はプロパティ自体が付かない", () => {
  const log = new DebugLog();
  log.push("orchestrator", "info", "status", "idle");
  assert.equal("detail" in log.snapshot()[0], false);
});

test("push: detail指定時はそのまま入る", () => {
  const log = new DebugLog();
  log.push("suggester", "error", "task-error", "A: 失敗", "stack trace...");
  assert.equal(log.snapshot()[0].detail, "stack trace...");
});

test("push: 上限超過で古い順に落ちる", () => {
  const log = new DebugLog();
  for (let i = 0; i < 505; i++) {
    log.push("watcher", "info", "cues", `msg${i}`);
  }
  const snap = log.snapshot();
  assert.equal(snap.length, 500);
  assert.equal(snap[0].message, "msg5"); // 先頭5件(0-4)が落ちている
  assert.equal(snap[snap.length - 1].message, "msg504");
});

test("snapshot: バッファのコピーを返す（呼び出し元の変更が内部に影響しない）", () => {
  const log = new DebugLog();
  log.push("watcher", "info", "meeting", "m1");
  const snap = log.snapshot();
  snap.push({
    at: "x",
    source: "watcher",
    level: "info",
    kind: "meeting",
    message: "injected",
  });
  assert.equal(log.snapshot().length, 1);
});

test("push: 'event' でリアルタイム配信される", () => {
  const log = new DebugLog();
  const received: string[] = [];
  log.on("event", (ev) => received.push(ev.message));
  log.push("orchestrator", "info", "trigger", "手動トリガー");
  assert.deepEqual(received, ["手動トリガー"]);
});
