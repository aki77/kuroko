import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { EditableConfig } from "../shared/types";

/**
 * GUIで編集した設定の永続化。userData/settings.json にフラットなJSONで保存する。
 * schema/migration は持たず、破損時のフォールバックは config.ts の正規化層に委ねる
 * （読み込み側は「JSONとして読めれば返す、ダメなら null」だけを保証する）。
 */
function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

/**
 * 保存済み設定を同期読みする。ファイル無し/JSON破損時は null（→ 既定へフォールバック）。
 * 値の妥当性（型・範囲）は検証しない。正規化は config.ts の loadConfig が行う。
 */
export function readSettings(): Partial<EditableConfig> | null {
  let raw: string;
  try {
    raw = readFileSync(settingsPath(), "utf8");
  } catch {
    return null; // ファイルが無い（初回起動など）
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Partial<EditableConfig>;
  } catch {
    return null; // JSON破損。既定値で動かす
  }
}

/**
 * 設定を保存する。tmpファイルに書いてから rename する atomic write で、
 * 書き込み途中にクラッシュしても settings.json が破損しないようにする。
 */
export function writeSettings(values: Partial<EditableConfig>): void {
  const path = settingsPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}
