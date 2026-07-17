/**
 * suggester.ts の toWeb() が使う details（箇条書き詳細）正規化ロジックだけを切り出した依存ゼロの純粋関数。
 * suggester.ts 自体は "../shared/url.js" 等の値importに依存しており、
 * node --experimental-strip-types のネイティブESMローダーでは拡張子付き相対import（実体は.ts）が解決できず
 * テストから直接importできない（watcher-stale.tsと同じ制約。詳細はそちらのコメント参照）。
 * この関数だけ依存を持たない別ファイルに分離し、テスト容易性を確保する。
 */

/**
 * 外部プロセス(claude)の出力を信頼しきらず、details（箇条書き詳細）を正規化する。
 * 文字列配列以外・空文字要素は取り除く。結果が空になった場合は undefined を返す
 * （呼び出し側で details プロパティ自体を省略し、renderer側の「details有無」判定を単純にするため）。
 */
export function normalizeWebDetails(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const details = raw.filter(
    (d): d is string => typeof d === "string" && d.trim() !== "",
  );
  return details.length > 0 ? details : undefined;
}
