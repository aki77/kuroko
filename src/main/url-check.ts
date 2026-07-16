// 「FROM THE WEB」の出典URLが生成後に本当に到達可能かを検証するユーティリティ（main専用）。
// src/shared/url.ts はrenderer兼用のためここには置かず、fetch(undici)を使う本ファイルをmain側に分離する。
// fetchは引数注入でテスト可能にする（git-url.tsの「副作用を関数で注入」パターンに倣う）。

/** fetchの結果として必要な部分だけを抜いた最小インターフェース（本物のResponseもこれを満たす） */
export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number }>;

/** 明示的に「無い」と判定してよいstatusだけを落とす対象にする（非対称ポリシー） */
const UNREACHABLE_STATUSES = [404, 410];

/** fetch完了後のstatusから「落とすべきか」を判定する純粋関数 */
export function isUnreachableStatus(status: number): boolean {
  return UNREACHABLE_STATUSES.includes(status);
}

/** 2xxのみ「確定到達可能」とする純粋関数。403/429/5xx等は判定不能(indeterminate)側に回す */
export function isReachableStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/** HEADが非対応(405/501)だったときだけGETへフォールバックする対象status */
const HEAD_UNSUPPORTED_STATUSES = [405, 501];

/** 1URLあたりのタイムアウト(ms)の既定値。呼び出し側(suggester.ts)のデフォルトもこれを参照する */
export const DEFAULT_URL_CHECK_TIMEOUT_MS = 4000;

export interface UrlCheckOptions {
  /** 1URLあたりのタイムアウト(ms)。既定 DEFAULT_URL_CHECK_TIMEOUT_MS */
  perUrlTimeoutMs?: number;
  /** テスト注入用のfetch実装。既定はグローバルfetch */
  fetchImpl?: FetchLike;
}

/** キャッシュに載せる内部判定状態。外部API(boolean)より粒度を細かくし、TTL選択に使う */
type UrlCheckState = "unreachable" | "reachable" | "indeterminate";

/** 判定結果のキャッシュ（アプリ起動中プロセス内で保持。会議切り替わりでの明示クリアは行わずTTL失効に任せる） */
const cache = new Map<string, { state: UrlCheckState; expiresAt: number }>();

/** 到達不可(404/410)と判定した結果のTTL。一度消えたURLが会議中に復活するケースは稀なため長め */
export const UNREACHABLE_CACHE_TTL_MS = 30 * 60 * 1000;
/** 確定到達可能(2xx)と判定した結果のTTL。一度到達確認できたURLが会議中に消えるケースは稀なため長め */
export const REACHABLE_CACHE_TTL_MS = 30 * 60 * 1000;
/** 判定不能（ネットワークエラー/タイムアウト/403/429/5xx等）判定のTTL。一時的な障害の可能性があるため短め */
export const INDETERMINATE_CACHE_TTL_MS = 60 * 1000;

/** 状態ごとのTTLテーブル。状態が増えてもここに1行足すだけでよく、ネストした条件分岐を避ける */
const TTL_MS_BY_STATE: Record<UrlCheckState, number> = {
  unreachable: UNREACHABLE_CACHE_TTL_MS,
  reachable: REACHABLE_CACHE_TTL_MS,
  indeterminate: INDETERMINATE_CACHE_TTL_MS,
};

/** テスト専用。test間の状態漏れを防ぐためcacheをクリアする（本番コードから呼ばない） */
export function __resetUrlCheckCacheForTest(): void {
  cache.clear();
}

/**
 * 単一URLの到達確認。到達不可(404/410)ならtrue。
 * ネットワークエラー・タイムアウトなど判定不能なケースはすべてfalse（=残す。疑わしきは残す方針）。
 * HEAD+GETフォールバック込みで1本のAbortController/タイマーを共有し、合計でperUrlTimeoutMsを超えないようにする。
 * 判定結果は内部で unreachable/reachable/indeterminate の3状態に分けてcacheに載せ、
 * 状態ごとに異なるTTLを適用する（確定到達可能は長命、判定不能は短命）。TTL内であればfetchをスキップする。
 */
export async function isUrlUnreachable(
  url: string,
  opts: UrlCheckOptions = {},
): Promise<boolean> {
  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.state === "unreachable";
  }

  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const timeoutMs = opts.perUrlTimeoutMs ?? DEFAULT_URL_CHECK_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const request = async (method: "HEAD" | "GET"): Promise<number | null> => {
    try {
      const res = await fetchImpl(url, {
        method,
        redirect: "follow",
        signal: controller.signal,
      });
      return res.status;
    } catch {
      return null; // ネットワークエラー・タイムアウト(abort)は判定不能 → 呼び出し元でfalse扱い
    }
  };

  /** statusから3状態を確定する（404/410は不可、2xxは確定到達可能、それ以外は判定不能） */
  const stateFromStatus = (status: number): UrlCheckState => {
    if (isUnreachableStatus(status)) return "unreachable";
    if (isReachableStatus(status)) return "reachable";
    return "indeterminate";
  };

  let state: UrlCheckState;
  try {
    const headStatus = await request("HEAD");
    if (headStatus === null) {
      state = "indeterminate"; // 到達確認自体が失敗 → 残す
    } else if (HEAD_UNSUPPORTED_STATUSES.includes(headStatus)) {
      // HEAD非対応のサーバーはGETで再試行（本文は読まずstatusだけ見る）
      const getStatus = await request("GET");
      state = getStatus === null ? "indeterminate" : stateFromStatus(getStatus);
    } else {
      state = stateFromStatus(headStatus);
    }
  } finally {
    clearTimeout(timer);
  }

  cache.set(url, { state, expiresAt: Date.now() + TTL_MS_BY_STATE[state] });
  return state === "unreachable";
}

/**
 * URL群のうち到達不可(404/410)なものだけをSetにして返す。
 * 呼び出し側は `unreachable.has(url)` で素直にfilterできる。
 * 同一URLはSetで一意化し、並行チェック（Promise.all）で追加レイテンシを最も遅い1本に抑える。
 */
export async function findUnreachableUrls(
  urls: string[],
  opts: UrlCheckOptions = {},
): Promise<Set<string>> {
  const uniqueUrls = Array.from(new Set(urls));
  const results = await Promise.all(
    uniqueUrls.map(
      async (url) => [url, await isUrlUnreachable(url, opts)] as const,
    ),
  );
  return new Set(
    results.filter(([, unreachable]) => unreachable).map(([url]) => url),
  );
}
