import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeWebDetails } from "./web-details.ts";

test("normalizeWebDetails: 文字列配列はそのまま返す", () => {
  assert.deepEqual(normalizeWebDetails(["a", "b"]), ["a", "b"]);
});

test("normalizeWebDetails: 非配列は undefined を返す", () => {
  assert.equal(normalizeWebDetails("not-an-array"), undefined);
  assert.equal(normalizeWebDetails(undefined), undefined);
  assert.equal(normalizeWebDetails(null), undefined);
  assert.equal(normalizeWebDetails(123), undefined);
});

test("normalizeWebDetails: 文字列以外・空文字要素は取り除く", () => {
  assert.deepEqual(
    normalizeWebDetails(["ok", "", "  ", 123, null, "also ok"]),
    ["ok", "also ok"],
  );
});

test("normalizeWebDetails: 全部無効な要素なら undefined を返す", () => {
  assert.equal(normalizeWebDetails(["", "  ", 1, null]), undefined);
});

test("normalizeWebDetails: 空配列は undefined を返す", () => {
  assert.equal(normalizeWebDetails([]), undefined);
});
