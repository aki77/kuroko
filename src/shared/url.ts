// メイン ↔ レンダラ双方のURL検証で共有するポリシー。
// 「httpsのみ許可」を1箇所に集約し、LLM出力の正規化層とIPCハンドラ層で
// 同じ判定がズレないようにする。

/** httpsで始まる文字列かどうかを判定する（LLM生成URL・IPC越しの値を信頼しないための唯一の判定箇所） */
export function isHttpsUrl(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\//i.test(value);
}
