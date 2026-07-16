import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { FetchLike } from "./url-check.ts";
import {
  __resetUrlCheckCacheForTest,
  findUnreachableUrls,
  INDETERMINATE_CACHE_TTL_MS,
  isReachableStatus,
  isUnreachableStatus,
  isUrlUnreachable,
  REACHABLE_CACHE_TTL_MS,
} from "./url-check.ts";

beforeEach(() => {
  __resetUrlCheckCacheForTest();
});

test("isUnreachableStatus: 404/410はtrue", () => {
  assert.equal(isUnreachableStatus(404), true);
  assert.equal(isUnreachableStatus(410), true);
});

test("isUnreachableStatus: 200/403/429/500/301はfalse", () => {
  assert.equal(isUnreachableStatus(200), false);
  assert.equal(isUnreachableStatus(403), false);
  assert.equal(isUnreachableStatus(429), false);
  assert.equal(isUnreachableStatus(500), false);
  assert.equal(isUnreachableStatus(301), false);
});

/** テスト用: url -> statusのマップからFetchLikeを作る */
function fakeFetch(statusByUrl: Record<string, number>): FetchLike {
  return async (url, _init) => {
    const status = statusByUrl[url];
    if (status === undefined) throw new Error(`unexpected url: ${url}`);
    return { ok: status >= 200 && status < 300, status };
  };
}

test("findUnreachableUrls: 200のurlはSetに含まれない", async () => {
  const result = await findUnreachableUrls(["https://a.example"], {
    fetchImpl: fakeFetch({ "https://a.example": 200 }),
  });
  assert.equal(result.has("https://a.example"), false);
});

test("findUnreachableUrls: 404/410のurlは含まれる", async () => {
  const result = await findUnreachableUrls(
    ["https://a.example", "https://b.example"],
    {
      fetchImpl: fakeFetch({
        "https://a.example": 404,
        "https://b.example": 410,
      }),
    },
  );
  assert.equal(result.has("https://a.example"), true);
  assert.equal(result.has("https://b.example"), true);
});

test("findUnreachableUrls: 403/429/500/301は残す(含まれない)", async () => {
  const statusByUrl = {
    "https://a.example": 403,
    "https://b.example": 429,
    "https://c.example": 500,
    "https://d.example": 301,
  };
  const result = await findUnreachableUrls(Object.keys(statusByUrl), {
    fetchImpl: fakeFetch(statusByUrl),
  });
  assert.equal(result.size, 0);
});

test("findUnreachableUrls: HEADが405ならGETにフォールバックし、GETのstatusで判定する", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(`${init.method}:${url}`);
    if (init.method === "HEAD") return { ok: false, status: 405 };
    return { ok: false, status: 404 }; // GETでは404
  };
  const result = await findUnreachableUrls(["https://a.example"], {
    fetchImpl,
  });
  assert.equal(result.has("https://a.example"), true);
  assert.deepEqual(calls, ["HEAD:https://a.example", "GET:https://a.example"]);
});

test("findUnreachableUrls: HEADが501でもGETにフォールバックする", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    calls.push(String(init.method));
    if (init.method === "HEAD") return { ok: false, status: 501 };
    return { ok: true, status: 200 };
  };
  const result = await findUnreachableUrls(["https://a.example"], {
    fetchImpl,
  });
  assert.equal(result.has("https://a.example"), false);
  assert.deepEqual(calls, ["HEAD", "GET"]);
});

test("isUrlUnreachable: fetchがrejectする(ネットワークエラー)場合はfalse(残す)", async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error("network error");
  };
  const result = await isUrlUnreachable("https://a.example", { fetchImpl });
  assert.equal(result, false);
});

test("isUrlUnreachable: AbortSignalによるタイムアウトもfalse(残す)", async () => {
  const fetchImpl: FetchLike = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
    });
  const result = await isUrlUnreachable("https://a.example", {
    fetchImpl,
    perUrlTimeoutMs: 10,
  });
  assert.equal(result, false);
});

test("isUrlUnreachable: HEADが405でGETがハングしても合計timeoutMs以内に解決する(回帰防止)", async () => {
  const timeoutMs = 50;
  const fetchImpl: FetchLike = async (_url, init) => {
    if (init.method === "HEAD") {
      // HEAD自体にもtimeoutMsの半分近くかかるケース。
      // 個別タイマー版だとHEAD分は消費されずGET側に丸ごとtimeoutMsが再度与えられ、合計で超過してしまう。
      await new Promise((resolve) => setTimeout(resolve, timeoutMs * 0.6));
      return { ok: false, status: 405 };
    }
    // GET側はabortされるまで応答しない(ハング相当)
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
    });
  };
  const start = performance.now();
  const result = await isUrlUnreachable("https://a.example", {
    fetchImpl,
    perUrlTimeoutMs: timeoutMs,
  });
  const elapsed = performance.now() - start;
  assert.equal(result, false);
  assert.ok(
    elapsed < timeoutMs * 1.3,
    `elapsed=${elapsed}ms がtimeoutMsを大きく超えている`,
  );
});

test("findUnreachableUrls: 重複urlは1回だけ問い合わせて両方に反映される", async () => {
  let callCount = 0;
  const fetchImpl: FetchLike = async () => {
    callCount++;
    return { ok: false, status: 404 };
  };
  const result = await findUnreachableUrls(
    ["https://a.example", "https://a.example"],
    {
      fetchImpl,
    },
  );
  assert.equal(callCount, 1);
  assert.equal(result.has("https://a.example"), true);
});

test("isUrlUnreachable: 404判定後の再呼び出しはキャッシュヒットしfetchが呼ばれない", async () => {
  let callCount = 0;
  const fetchImpl: FetchLike = async () => {
    callCount++;
    return { ok: false, status: 404 };
  };
  const first = await isUrlUnreachable("https://a.example", { fetchImpl });
  const second = await isUrlUnreachable("https://a.example", { fetchImpl });
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(callCount, 1);
});

test("isUrlUnreachable: fetchImplが同期throwしてもrejectせずfalse(残す)を返す(回帰防止)", async () => {
  // fetch非対応環境などでfetchImpl呼び出し自体が同期的にTypeErrorを投げるケースを想定。
  // request()内のtry/catchがfetchImpl呼び出し式を包んでいることを保証する。
  const fetchImpl: FetchLike = () => {
    throw new TypeError("fetch is not a function");
  };
  const result = await isUrlUnreachable("https://a.example", { fetchImpl });
  assert.equal(result, false);
});

test("isReachableStatus: 200-299はtrue、それ以外はfalse", () => {
  assert.equal(isReachableStatus(200), true);
  assert.equal(isReachableStatus(204), true);
  assert.equal(isReachableStatus(299), true);
  assert.equal(isReachableStatus(300), false);
  assert.equal(isReachableStatus(199), false);
  assert.equal(isReachableStatus(403), false);
  assert.equal(isReachableStatus(500), false);
});

test("isUrlUnreachable: 確定到達可能(200)判定後の再呼び出しはキャッシュヒットしfetchが呼ばれない(回帰防止)", async () => {
  let callCount = 0;
  const fetchImpl: FetchLike = async () => {
    callCount++;
    return { ok: true, status: 200 };
  };
  const first = await isUrlUnreachable("https://a.example", { fetchImpl });
  const second = await isUrlUnreachable("https://a.example", { fetchImpl });
  assert.equal(first, false);
  assert.equal(second, false);
  assert.equal(callCount, 1);
});

test("TTL定数: 判定不能用は確定到達可能用より短い", () => {
  assert.ok(INDETERMINATE_CACHE_TTL_MS < REACHABLE_CACHE_TTL_MS);
});

test("findUnreachableUrls: 空配列はfetchを呼ばずSetを返す", async () => {
  let called = false;
  const fetchImpl: FetchLike = async () => {
    called = true;
    return { ok: true, status: 200 };
  };
  const result = await findUnreachableUrls([], { fetchImpl });
  assert.equal(called, false);
  assert.equal(result.size, 0);
});
