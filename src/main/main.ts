import { join } from "node:path";
import { app, BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import type { Status, SuggestionUpdate } from "../shared/types";
import { Orchestrator } from "./orchestrator";

let win: BrowserWindow | null = null;
let orchestrator: Orchestrator | null = null;
let clickThrough = false;

const WIDTH = 380;
const MARGIN = 24;

function createWindow(): void {
  const { workArea } = screen.getPrimaryDisplay();

  win = new BrowserWindow({
    width: WIDTH,
    height: workArea.height - MARGIN * 2,
    // 画面右上に寄せる（Cluely風）
    x: workArea.x + workArea.width - WIDTH - MARGIN,
    y: workArea.y + MARGIN,
    frame: false, // タイトルバー等なし
    transparent: true, // 背景透過（半透明ガラスUIをrendererで作る）
    hasShadow: false,
    resizable: true,
    skipTaskbar: true, // タスクバー/Dockに出さない
    focusable: true, // カスタムコンテキスト入力に備えてフォーカス可能に
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 常に最前面。screen-saverレベルでフルスクリーンの会議アプリより前に出す
  win.setAlwaysOnTop(true, "screen-saver");
  // すべての仮想デスクトップ／フルスクリーンスペースで表示
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // ★Cluelyの肝: 画面共有・画面録画にこのウィンドウを映さない
  win.setContentProtection(true);

  win.loadFile(join(__dirname, "..", "renderer", "index.html"));
}

function wireOrchestrator(): void {
  orchestrator = new Orchestrator();
  orchestrator.on("suggestion", (u: SuggestionUpdate) => {
    win?.webContents.send("suggestion", u);
  });
  orchestrator.on("status", (s: Status) => {
    win?.webContents.send("status", s);
  });
  void orchestrator.start();
}

function registerShortcuts(): void {
  // Cmd+Shift+K: 今すぐ提案を再生成（手動トリガー）
  globalShortcut.register("CommandOrControl+Shift+K", () => {
    orchestrator?.triggerNow();
  });
  // Cmd+Shift+H: オーバーレイの表示/非表示トグル
  globalShortcut.register("CommandOrControl+Shift+H", () => {
    if (!win) return;
    win.isVisible() ? win.hide() : win.show();
  });
  // Cmd+Shift+X: クリックスルー（マウス素通り）トグル。会議操作を邪魔しないため
  globalShortcut.register("CommandOrControl+Shift+X", () => {
    if (!win) return;
    clickThrough = !clickThrough;
    win.setIgnoreMouseEvents(clickThrough, { forward: true });
    win.webContents.send("click-through", clickThrough);
  });
}

// レンダラからの手動トリガー要求
ipcMain.on("trigger-now", () => orchestrator?.triggerNow());

app.whenReady().then(() => {
  createWindow();
  wireOrchestrator();
  registerShortcuts();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// オーバーレイ用途なので全ウィンドウを閉じても常駐させる（macOS標準挙動）
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  void orchestrator?.stop();
});
