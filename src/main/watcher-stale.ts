/**
 * watcher.ts から stale 判定だけを切り出した依存ゼロの純粋関数。
 * watcher.ts は "./config"（拡張子なしimport、CommonJSビルド前提）に依存しており、
 * node --experimental-strip-types のネイティブESMローダーでは拡張子なし相対importが解決できず
 * テストから直接importできない。この関数だけ依存を持たない別ファイルに分離し、テスト容易性を確保する。
 */

/** 最新ファイルのmtimeが now 基準で staleMs 以上前なら true（起動時に会議採用しない判定）。単位変換は呼び出し側の責務 */
export function isStaleLatest(
  mtimeMs: number,
  nowMs: number,
  staleMs: number,
): boolean {
  return nowMs - mtimeMs >= staleMs;
}
