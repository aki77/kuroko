import { test } from "node:test";
import assert from "node:assert/strict";
// isStaleLatest は watcher.ts から呼ばれる依存ゼロの純粋関数だが、watcher.ts 自体は
// "./config"（拡張子なし・CommonJSビルド前提）に依存しており、node --experimental-strip-types の
// ネイティブESMローダーでは拡張子なし相対importが解決できず watcher.ts を直接importできない。
// そのためテスト容易性のために isStaleLatest だけを依存ゼロの watcher-stale.ts に切り出している。
import { isStaleLatest } from "./watcher-stale.ts";

test("isStaleLatest: 経過時間がstaleMsちょうど -> true（境界値は古い扱い）", () => {
  assert.equal(isStaleLatest(1000, 1000 + 5000, 5000), true);
});

test("isStaleLatest: 経過時間がstaleMs未満 -> false", () => {
  assert.equal(isStaleLatest(1000, 1000 + 4999, 5000), false);
});

test("isStaleLatest: 経過時間がstaleMsを超える -> true", () => {
  assert.equal(isStaleLatest(1000, 1000 + 5001, 5000), true);
});

test("isStaleLatest: staleMs=0 -> mtimeが過去・現在なら常にtrue（デバッグ用の常時待機）", () => {
  assert.equal(isStaleLatest(1000, 1000, 0), true);
  assert.equal(isStaleLatest(1000, 1001, 0), true);
});

test("isStaleLatest: 未来のmtime(負の経過) -> false", () => {
  assert.equal(isStaleLatest(2000, 1000, 5000), false);
});

// parseTranscript（watcher.ts）は "./config" 経由で上記と同じ拡張子なしimport問題に当たるため、
// テストランナーから直接importできず対象外とする（プラン注記「余力があれば」の範囲としてスキップ）。
