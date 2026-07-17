import { join } from "node:path";
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  screen,
  shell,
} from "electron";
import type {
  DebugEvent,
  EditableConfig,
  Status,
  SuggestionPartUpdate,
  SuggestionUpdate,
} from "../shared/types.js";
import { isHttpsUrl } from "../shared/url.js";
import {
  applyEditable,
  config,
  getConfigState,
  getPersistableValues,
  loadConfig,
  setFocusMode,
} from "./config.js";
import { bridgeToDebugLog, debugLog } from "./debug-log.js";
import { Orchestrator } from "./orchestrator.js";
import { Replayer } from "./replayer.js";
import { readSettings, writeSettings } from "./settings-store.js";
import {
  CONTEXT_SUMMARIZE_THRESHOLD,
  summarizeMeetingContext,
} from "./suggester.js";

let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let contextWin: BrowserWindow | null = null;
let debugWin: BrowserWindow | null = null;
let orchestrator: Orchestrator | null = null;
let replayer: Replayer | null = null;
let clickThrough = false;

const WIDTH = 380;
const MARGIN = 24;
const PRELOAD_PATH = join(import.meta.dirname, "preload.cjs");

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
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 常に最前面。screen-saverレベルでフルスクリーンの会議アプリより前に出す
  win.setAlwaysOnTop(true, "screen-saver");
  // すべての仮想デスクトップ／フルスクリーンスペースで表示
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // ★Cluelyの肝: 画面共有・画面録画にこのウィンドウを映さない（設定で切替可能。config:setハンドラで即反映もする）
  win.setContentProtection(config.contentProtection);

  win.loadFile(join(import.meta.dirname, "..", "renderer", "index.html"));
}

/**
 * オーバーレイと違う普通のフレーム付き通常ウィンドウ（settings/context/debug）を開く共通処理。
 * transparent/alwaysOnTop/contentProtection は付けず、preload は overlay と共用する
 * （各ウィンドウで使わないAPIも生えるが無害）。多重生成は呼び出し側の existing で防ぐ。
 * onReady は初回ロード完了時の追加処理（例: デバッグウィンドウのsnapshot流し込み）に使う。
 */
function openManagedWindow(
  existing: BrowserWindow | null,
  opts: {
    width: number;
    height: number;
    title: string;
    file: string;
    onClosed: () => void;
    onReady?: (w: BrowserWindow) => void;
  },
): BrowserWindow {
  if (existing) {
    existing.focus();
    return existing;
  }
  const w = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    title: opts.title,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  w.on("closed", opts.onClosed);
  if (opts.onReady) {
    w.webContents.once("did-finish-load", () => opts.onReady?.(w));
  }
  w.loadFile(join(import.meta.dirname, "..", "renderer", opts.file));
  return w;
}

function openSettingsWindow(): void {
  settingsWin = openManagedWindow(settingsWin, {
    width: 480,
    height: 620,
    title: "KUROKO 設定",
    file: "settings.html",
    onClosed: () => {
      settingsWin = null;
    },
  });
}

/** 長文の貼り付け・確認を行うため設定ウィンドウより広めのサイズにする。 */
function openContextWindow(): void {
  contextWin = openManagedWindow(contextWin, {
    width: 560,
    height: 640,
    title: "KUROKO コンテキスト",
    file: "context.html",
    onClosed: () => {
      contextWin = null;
    },
  });
}

/**
 * デバッグウィンドウ（開発・動作確認用）。開いた直後に debugLog.snapshot() を流し込み
 * 直近バッファを復元する。以降のライブ配信は wireOrchestrator 隣の debugLog.on("event", ...) が担う。
 */
function openDebugWindow(): void {
  debugWin = openManagedWindow(debugWin, {
    width: 720,
    height: 640,
    title: "KUROKO デバッグ",
    file: "debug.html",
    onClosed: () => {
      debugWin = null;
    },
    onReady: (w) => w.webContents.send("debug:snapshot", debugLog.snapshot()),
  });
}

/** 開いている全ウィンドウへ同一イベントを送る。個別ハンドラでの送信先ベタ書きの増殖を防ぐ。 */
function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(channel, payload);
  }
}

async function wireOrchestrator(): Promise<void> {
  orchestrator = new Orchestrator();
  orchestrator.on("suggestion", (u: SuggestionUpdate) => {
    win?.webContents.send("suggestion", u);
  });
  orchestrator.on("suggestion-part", (u: SuggestionPartUpdate) => {
    win?.webContents.send("suggestion-part", u);
  });
  orchestrator.on("status", (s: Status) => {
    win?.webContents.send("status", s);
  });
  // デバッグウィンドウへのライブ配信。debugWinが無ければ何もしない（バッファには積まれ続ける）
  debugLog.on("event", (ev: DebugEvent) => {
    debugWin?.webContents.send("debug:event", ev);
  });
  await orchestrator.start(); // ready完了まで待つ（chokidarのignoreInitial:trueとの競合回避）

  if (config.replayFile) {
    // 【開発用】隠しリプレイモード: watcherがready後に仮ファイルを作成し、addを確実に検知させる
    replayer = new Replayer(config.replayFile, config.replaySpeed);
    await replayer.start();
    const cleanup = () => {
      replayer?.stopSync();
      process.exit(0);
    };
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
}

/**
 * アプリメニューを構築する。Electron既定メニュー（Manually creating the default menu）
 * 同等の構成をそのまま使う（カスタム項目は持たない）。
 * デバッグウィンドウはオーバーレイ内の🐞ボタン（open-debug IPC）から開く
 * （オーバーレイがメニューバーをアクティブ化できずメニュー経由の導線が使えないため）。
 */
function buildMenu(): Menu {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "編集",
      submenu: [
        { role: "undo" as const },
        { role: "redo" as const },
        { type: "separator" as const },
        { role: "cut" as const },
        { role: "copy" as const },
        { role: "paste" as const },
        { role: "selectAll" as const },
      ],
    },
    {
      label: "表示",
      submenu: [
        { role: "reload" as const },
        { role: "forceReload" as const },
        { role: "toggleDevTools" as const },
        { type: "separator" as const },
        { role: "resetZoom" as const },
        { role: "zoomIn" as const },
        { role: "zoomOut" as const },
        { type: "separator" as const },
        { role: "togglefullscreen" as const },
      ],
    },
    {
      label: "ウィンドウ",
      submenu: [
        { role: "minimize" as const },
        { role: "zoom" as const },
        ...(isMac
          ? [
              { type: "separator" as const },
              { role: "front" as const },
              { type: "separator" as const },
              { role: "window" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
    {
      label: "ヘルプ",
      role: "help" as const,
      submenu: [],
    },
  ];
  return Menu.buildFromTemplate(template);
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

// レンダラからの外部リンクオープン要求。メイン側でも再度URLスキームを検証する（多層防御）
ipcMain.on("open-external", (_e, url: unknown) => {
  if (isHttpsUrl(url)) {
    shell.openExternal(url);
  }
});

// ⚙ボタンから設定ウィンドウを開く
ipcMain.on("open-settings", () => openSettingsWindow());

// オーバーレイの「コンテキスト」ボタンからコンテキスト専用ウィンドウを開く
ipcMain.on("open-context", () => openContextWindow());

// オーバーレイのデバッグボタンからデバッグウィンドウを開く
ipcMain.on("open-debug", () => openDebugWindow());

// 設定ウィンドウ ↔ メインの往復（invoke/handle）
ipcMain.handle("config:get", () => getConfigState());
ipcMain.handle("config:set", async (_e, next: Partial<EditableConfig>) => {
  const before = {
    transcriptDir: config.transcriptDir,
    contentProtection: config.contentProtection,
    fontScale: config.fontScale,
  };
  applyEditable(next); // env固定キーは無視され、正規化された実効値がconfigに反映される
  writeSettings(getPersistableValues()); // env固定でないキーの実効値（クランプ後）だけを永続化する
  // transcriptDir が変わったときだけ watcher を再起動する（それ以外は即反映で足りる）
  if (config.transcriptDir !== before.transcriptDir) {
    await orchestrator?.restartWatcher();
  }
  // content protectionが変わったときだけ実行中のオーバーレイへ即反映する（再起動不要にするため）
  if (config.contentProtection !== before.contentProtection) {
    win?.setContentProtection(config.contentProtection);
  }
  // fontScaleが変わったときだけオーバーレイへ即反映する
  if (config.fontScale !== before.fontScale) {
    broadcast("font-scale-changed", config.fontScale);
  }
  return { ok: true, state: getConfigState() };
});

// オーバーレイの集中モードボタン専用（設定画面/envとは無関係・非永続化）。
// env固定という概念自体が無いため、押せば必ず効く。
ipcMain.on("focus-mode:set", (_e, enabled: boolean) => {
  setFocusMode(enabled);
  broadcast("focus-mode-changed", config.focusMode);
});

// オーバーレイのチャット欄からの送信専用（発話cuesと並ぶもう一つの入力口）。
// 即トリガーで提案は既存の "suggestion"/"status" 経路で返るため、invoke で回答を待つ必要はない。
ipcMain.on("chat:submit", (_e, text: unknown) => {
  if (typeof text === "string") orchestrator?.submitChatInput(text);
});

// 会議コンテキスト（アジェンダ・資料）確定時の要約IPC。
// claude -p を挟む非同期処理（数十秒かかりうる）を config:set とは別経路にし、
// 他の設定変更（即時同期）をブロックしないようにする。
ipcMain.handle("context:summarize", async (_e, raw: unknown) => {
  // env固定の二重防御（renderer側もlocked時は呼ばない想定だが、main側でも防ぐ）
  const stateBefore = getConfigState();
  if (stateBefore.envLocked.meetingContext === true) {
    return { ok: true, summarized: false, state: stateBefore };
  }

  // 空・閾値以下は原文をそのまま採用。閾値超過時だけ要約し、失敗したら原文へフォールバックする
  // （切り詰めない＝会議情報の欠落を避け、失敗時もプロンプト肥大という既存同等の劣化に留める）。
  // 分岐ごとにapplyEditable/returnを重複させず、value/summarized/errorを決めてから一度だけ確定する。
  const text = typeof raw === "string" ? raw : "";
  const trimmed = text.trim();

  // 要約前に原文を先に確定させる。要約はclaude -pで最大60秒かかりうるが、
  // このハンドラはコンテキストウィンドウのライフサイクルと独立に走り続けるため、
  // 要約完了前にウィンドウを閉じても原文がconfigに残るようにし、
  // 完了時に要約版で上書きする（クローズによる入力データ消失を防ぐ）。
  applyEditable({ meetingContext: trimmed ? trimmed : "" });

  let value = text;
  let summarized = false;
  let error: string | undefined;

  if (trimmed && trimmed.length > CONTEXT_SUMMARIZE_THRESHOLD) {
    try {
      value = await summarizeMeetingContext(text, bridgeToDebugLog);
      summarized = true;
    } catch (err) {
      console.warn("context summarize failed:", err);
      error = err instanceof Error ? err.message : String(err);
    }
  }

  // 要約完了。要約版（または原文/失敗時フォールバック）で確定し直す。
  applyEditable({ meetingContext: trimmed ? value : "" });
  const state = getConfigState();
  broadcast("meeting-context-changed", state);
  return { ok: true, summarized, state, error };
});

app.whenReady().then(async () => {
  // 設定を確定してから watcher を起動する（transcriptDir が watcher に使われるため最重要）
  loadConfig(readSettings());

  createWindow();
  Menu.setApplicationMenu(buildMenu());
  await wireOrchestrator();
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
  replayer?.stopSync();
});
