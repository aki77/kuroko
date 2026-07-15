import { contextBridge, ipcRenderer } from "electron";
import type {
  ConfigState,
  EditableConfig,
  Status,
  SuggestionUpdate,
} from "../shared/types";

/** レンダラに公開するAPI。contextIsolation下で安全に橋渡しする。 */
const api = {
  onSuggestion(cb: (u: SuggestionUpdate) => void): void {
    ipcRenderer.on("suggestion", (_e, u: SuggestionUpdate) => cb(u));
  },
  onStatus(cb: (s: Status) => void): void {
    ipcRenderer.on("status", (_e, s: Status) => cb(s));
  },
  onClickThrough(cb: (enabled: boolean) => void): void {
    ipcRenderer.on("click-through", (_e, enabled: boolean) => cb(enabled));
  },
  triggerNow(): void {
    ipcRenderer.send("trigger-now");
  },
  openExternal(url: string): void {
    ipcRenderer.send("open-external", url);
  },
  // --- 設定（設定ウィンドウで使用。オーバーレイ側では未使用） ---
  getConfig(): Promise<ConfigState> {
    return ipcRenderer.invoke("config:get");
  },
  setConfig(v: Partial<EditableConfig>): Promise<{ ok: boolean; state: ConfigState }> {
    return ipcRenderer.invoke("config:set", v);
  },
  openSettings(): void {
    ipcRenderer.send("open-settings");
  },
  summarizeContext(
    raw: string,
  ): Promise<{ ok: boolean; summarized: boolean; state: ConfigState; error?: string }> {
    return ipcRenderer.invoke("context:summarize", raw);
  },
};

contextBridge.exposeInMainWorld("kuroko", api);

export type KurokoApi = typeof api;
