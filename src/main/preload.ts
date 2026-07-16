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
  openContext(): void {
    ipcRenderer.send("open-context");
  },
  summarizeContext(
    raw: string,
  ): Promise<{ ok: boolean; summarized: boolean; state: ConfigState; error?: string }> {
    return ipcRenderer.invoke("context:summarize", raw);
  },
  onMeetingContextChanged(cb: (state: ConfigState) => void): void {
    ipcRenderer.on("meeting-context-changed", (_e, s: ConfigState) => cb(s));
  },
  onFontScaleChanged(cb: (scale: number) => void): void {
    ipcRenderer.on("font-scale-changed", (_e, scale: number) => cb(scale));
  },
  onFocusModeChanged(cb: (enabled: boolean) => void): void {
    ipcRenderer.on("focus-mode-changed", (_e, enabled: boolean) => cb(enabled));
  },
  // オーバーレイの集中モードボタン専用（設定画面/envとは無関係・非永続化）
  setFocusMode(enabled: boolean): void {
    ipcRenderer.send("focus-mode:set", enabled);
  },
};

contextBridge.exposeInMainWorld("kuroko", api);

export type KurokoApi = typeof api;
