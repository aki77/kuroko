// レンダラ。preloadが公開する window.kuroko 経由でメインからイベントを受け取り、
// 提案パネルを描画する。（プレーンJS。tscの対象外なのでdistへコピーされる）

/** @type {import('../main/preload.cts').KurokoApi} */
const api = window.kuroko;

const el = {
  statusDot: document.getElementById("statusDot"),
  statusLine: document.getElementById("statusLine"),
  empty: document.getElementById("empty"),
  topicBlock: document.getElementById("topicBlock"),
  topicHeader: document.getElementById("topicHeader"),
  summaryCaret: document.getElementById("summaryCaret"),
  topic: document.getElementById("topic"),
  discussion: document.getElementById("discussion"),
  questionsBlock: document.getElementById("questionsBlock"),
  questions: document.getElementById("questions"),
  webBlock: document.getElementById("webBlock"),
  web: document.getElementById("web"),
  codeBlock: document.getElementById("codeBlock"),
  code: document.getElementById("code"),
  footer: document.getElementById("footer"),
  footerStatus: document.getElementById("footerStatus"),
  refreshBtn: document.getElementById("refreshBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  focusModeBtn: document.getElementById("focusModeBtn"),
  historyPrevBtn: document.getElementById("historyPrevBtn"),
  historyNextBtn: document.getElementById("historyNextBtn"),
  historyPosition: document.getElementById("historyPosition"),
  historyUnseen: document.getElementById("historyUnseen"),
  urlTooltip: document.getElementById("urlTooltip"),
  projectDirInput: document.getElementById("projectDirInput"),
  projectDirSuggest: document.getElementById("projectDirSuggest"),
  projectDirLock: document.getElementById("projectDirLock"),
  contextOpenBtn: document.getElementById("contextOpenBtn"),
  contextBadge: document.getElementById("contextBadge"),
  contextLock: document.getElementById("contextLock"),
};

// 同一会議中のみ保持する提案履歴
let history = [];
let cursor = -1; // history.length - 1 = 最新を表示中
let hasUnseenLatest = false;

// ライブ枠: 生成中のA/B/C部分結果を随時マージ描画するための一時バッファ。
// 完成品はhistoryへ1件pushして確定するが、生成途中の値はhistoryに残したくないため
// （キャンセル・破棄されうる未確定値をナビゲーション対象の履歴に混ぜないため）historyとは別に持つ。
// 完成品(onSuggestion)が届いたらクリアする。meetingFileはliveDraft自身に持たせ、
// 「バッファなし」と「対象会議なし」を別々の変数で二重管理しない。
// 各パート(summary/web/code)は「まだ届いていない」ことを表すため既定値をundefinedにする
// （空配列[]等の実データと区別するため。goToHistoryで最新復帰時、届いたパートだけを完成品へ上書きする）。
function createLiveDraft(meetingFile) {
  return { meetingFile, summary: undefined, web: undefined, code: undefined };
}

let liveDraft = null;

// 情報量モード（集中／通常）。設定ウィンドウとも同期するためモジュールスコープで保持する
let focusMode = false;

// 要約本文（#discussion）の折りたたみ状態。保存はせず、モード切替・会議切替のたびに
// デフォルト（集中=折りたたみ／通常=展開）へ戻す（同一会議内の新ラウンドでは維持する）。
// summaryCollapsedTouchedはモード切替/会議切替までの間にユーザーが手動でヘッダをクリック
// したかどうかを示し、trueの間はrenderTopicでのデフォルト再適用を抑止する（手動操作の
// 意図をその間は尊重するため）。
let summaryCollapsed = false;
let summaryCollapsedTouched = false;

function applySummaryCollapsed() {
  el.discussion.hidden = summaryCollapsed;
  el.topicBlock.classList.toggle("collapsed", summaryCollapsed);
  el.summaryCaret.textContent = summaryCollapsed ? "▶" : "▼";
  el.topicHeader.setAttribute("aria-expanded", String(!summaryCollapsed));
}

// 境界（会議切替・モード切替）で呼ぶ。手動開閉の意図はその間限りのため、
// 境界を跨いだら破棄しデフォルト（focusMode連動）へ戻す。
// 呼び出し側（resetHistory/applyFocusMode）で個別にsummaryCollapsedを書かずここへ集約する。
// DOM反映（applySummaryCollapsed）まで含めて自己完結させ、呼び出し側が反映を呼び忘れないようにする。
function resetSummaryCollapsed() {
  summaryCollapsedTouched = false;
  summaryCollapsed = focusMode;
  applySummaryCollapsed();
}

el.refreshBtn.addEventListener("click", () => api.triggerNow());
el.settingsBtn.addEventListener("click", () => api.openSettings());
el.focusModeBtn.addEventListener("click", () => {
  // 送信値はローカルの focusMode を即反転して予測する（連打時に古い値を送るのを防ぐ）。
  // 表示同期は従来どおり onFocusModeChanged の push 通知（focus-mode-changed）に一本化する。
  // push が届くと applyFocusMode が実効値で focusMode を上書きするため予測値と収束する。
  // ここで .then(applyFocusMode) すると push と二重に発火し render が二度走るため呼ばない。
  focusMode = !focusMode;
  api.setFocusMode(focusMode);
});
el.historyPrevBtn.addEventListener("click", () => goToHistory(cursor - 1));
el.historyNextBtn.addEventListener("click", () => goToHistory(cursor + 1));
el.historyUnseen.addEventListener("click", () =>
  goToHistory(history.length - 1),
);

el.topicHeader.addEventListener("click", () => {
  summaryCollapsed = !summaryCollapsed;
  summaryCollapsedTouched = true;
  applySummaryCollapsed();
});

// ⌘系ショートカットはウィンドウローカル（オーバーレイにフォーカスがある時だけ効く）にまとめる。
// 現状は履歴ナビ（⌘⇧←/→）専用。
document.addEventListener("keydown", (e) => {
  if (!e.metaKey || !e.shiftKey) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    goToHistory(cursor - 1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    goToHistory(cursor + 1);
  }
});

api.onStatus((s) => {
  el.statusDot.className = "dot";
  switch (s.kind) {
    case "no-meeting":
      el.statusDot.classList.add("idle");
      el.statusLine.textContent = "進行中の会議を待機中…";
      resetHistory();
      break;
    case "idle":
      el.statusDot.classList.add("idle");
      el.statusLine.textContent = "待機中";
      break;
    case "waiting":
      el.statusDot.classList.add("idle");
      el.statusLine.textContent = `新しい発言を収集中… (${s.pendingCues}/${s.needed})`;
      break;
    case "querying":
      el.statusDot.classList.add("querying");
      el.statusLine.textContent = "Claudeが考え中…";
      break;
    case "error":
      el.statusDot.classList.add("error");
      el.statusLine.textContent = `エラー: ${truncate(s.message, 80)}`;
      // このラウンドは失敗し suggestion（完成品）が来ないため liveDraft は不確定値のまま残る。
      // クリアしないと次ラウンドの部分結果とミックスされる（旧ラウンドのweb/code + 新ラウンドのtopic等）
      liveDraft = null;
      break;
  }
});

api.onSuggestion((u) => {
  const last = history[history.length - 1];
  if (!last || last.meetingFile !== u.meetingFile) {
    resetHistory();
  }

  const wasViewingLatest = cursor === history.length - 1;
  history.push(u);

  // 完成品確定。ライブ枠をクリアし、最終renderで完成形へ収束させる
  liveDraft = null;

  if (wasViewingLatest) {
    cursor = history.length - 1;
    render(u);
  } else {
    hasUnseenLatest = true;
  }
  updateHistoryNav();
});

api.onSuggestionPart((u) => {
  // 履歴が旧会議のまま残っている状態で新会議のライブ部分が届いたら、
  // 旧会議の完成品はもう来ないため履歴ごとリセットする（"meeting"がno-meetingを経由せず
  // 連続発火するケースでresetHistory()が呼ばれず、旧会議のhistory/footerが残ることがある）
  const last = history[history.length - 1];
  if (last && last.meetingFile !== u.meetingFile) {
    resetHistory();
  }

  // 会議切替済みの古い部分は無視（ライブ枠を新会議のものと混在させない）
  if (!liveDraft || liveDraft.meetingFile !== u.meetingFile) {
    liveDraft = createLiveDraft(u.meetingFile);
  }

  // 過去閲覧中はライブ枠を描画しない（新着バッジのみ従来どおり）。バッファ更新は継続する
  const isViewingLatest = cursor === history.length - 1;

  switch (u.part.kind) {
    case "summary":
      liveDraft.summary = u.part.data;
      if (isViewingLatest) {
        renderTopic(u.part.data);
        renderQuestions(u.part.data);
      }
      break;
    case "web":
      liveDraft.web = u.part.data;
      if (isViewingLatest) renderWeb(liveDraft);
      break;
    case "code":
      liveDraft.code = u.part.data;
      if (isViewingLatest) renderCode(liveDraft);
      break;
  }

  if (isViewingLatest) el.empty.hidden = true;
});

api.onClickThrough((enabled) => {
  document.body.classList.toggle("click-through", enabled);
});

// --- 参照プロジェクトディレクトリ入力欄 ---
// projectDirはmain側で非永続化（起動ごとに空へリセット）。履歴のみレンダラのlocalStorageで保持する。
const PROJECT_DIR_HISTORY_KEY = "kuroko:projectDirHistory";
const PROJECT_DIR_HISTORY_MAX = 12;

function loadProjectDirHistory() {
  try {
    const raw = localStorage.getItem(PROJECT_DIR_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((v) => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

function saveProjectDirHistory(list) {
  try {
    localStorage.setItem(PROJECT_DIR_HISTORY_KEY, JSON.stringify(list));
  } catch {
    // localStorage不可時は履歴保存を諦める（機能自体は継続）
  }
}

// Electronのオーバーレイはalways-on-topの透過ウィンドウのため、<datalist>のネイティブ
// ポップアップが背後に隠れてクリックできない（URLツールチップと同じ問題、style.css参照）。
// そのため候補は自前の<ul>にDOM描画し、絞り込み・表示/非表示・選択確定も自前で行う。
let projectDirHistoryCache = [];

function renderProjectDirSuggest(list) {
  el.projectDirSuggest.replaceChildren();
  for (const dir of list) {
    const li = document.createElement("li");
    li.textContent = dir;
    // mousedownはblurより先に発火するため、確定前にドロップダウンが閉じるのを防げる
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      el.projectDirInput.value = dir;
      commitProjectDir();
      closeProjectDirSuggest();
    });
    el.projectDirSuggest.appendChild(li);
  }
}

function openProjectDirSuggest() {
  const value = el.projectDirInput.value.trim();
  const filtered = value
    ? projectDirHistoryCache.filter((d) => d.includes(value))
    : projectDirHistoryCache;
  renderProjectDirSuggest(filtered);
  el.projectDirSuggest.hidden = filtered.length === 0;
}

function closeProjectDirSuggest() {
  el.projectDirSuggest.hidden = true;
}

function addProjectDirHistory(dir) {
  const history = projectDirHistoryCache.filter((v) => v !== dir);
  history.unshift(dir);
  const trimmed = history.slice(0, PROJECT_DIR_HISTORY_MAX);
  saveProjectDirHistory(trimmed);
  projectDirHistoryCache = trimmed;
}

function commitProjectDir() {
  const value = el.projectDirInput.value.trim();
  api.setConfig({ projectDir: value });
  if (value) addProjectDirHistory(value);
}

function initProjectDirInput(state) {
  projectDirHistoryCache = loadProjectDirHistory();

  const locked = state.envLocked.projectDir === true;
  el.projectDirInput.value = state.values.projectDir || "";
  el.projectDirInput.disabled = locked;
  el.projectDirLock.hidden = !locked;

  if (locked) return; // env固定時は編集不可なので保存/履歴処理も不要

  el.projectDirInput.addEventListener("input", openProjectDirSuggest);
  el.projectDirInput.addEventListener("focus", openProjectDirSuggest);
  el.projectDirInput.addEventListener("blur", closeProjectDirSuggest);
  el.projectDirInput.addEventListener("change", commitProjectDir);
  el.projectDirInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitProjectDir();
      closeProjectDirSuggest();
    } else if (e.key === "Escape") {
      closeProjectDirSuggest();
    }
  });
}

// --- 会議コンテキスト（アジェンダ・資料）バッジ ---
// 入力・確認UIは専用ウィンドウ（context.html）へ切り出し済み。オーバーレイ側は
// 「登録済み」バッジ＋env固定🔒の表示と、専用ウィンドウを開くボタンだけを持つ。
function updateContextBadge(state) {
  const locked = state.envLocked.meetingContext === true;
  el.contextBadge.hidden = !state.values.meetingContext?.trim();
  el.contextLock.hidden = !locked;
}

function initContextBadge(state) {
  updateContextBadge(state);
  el.contextOpenBtn.addEventListener("click", () => api.openContext());
}

// push通知: 専用ウィンドウでの更新をオーバーレイのバッジへ即反映する
api.onMeetingContextChanged((state) => updateContextBadge(state));

// --- 文字サイズ（fontScale） ---
function applyFontScale(scale) {
  document.documentElement.style.fontSize = `${16 * scale}px`;
}

// --- 情報量モード（focusMode） ---
// 集中モードのときもFROM THE WEB/CODEブロックは非表示にしない（生成段階で最大2件に絞られる。
// 「集中モードのときは見れて候補2つまで」= 表示は残す方針）。表示件数はrender側では絞らないため、
// 既存の表示中の提案を再描画する必要もない。ボタン表示の同期のみ行う。
function applyFocusMode(enabled) {
  focusMode = enabled === true;
  el.focusModeBtn.textContent = focusMode ? "🎯 集中" : "📋 通常";
  el.focusModeBtn.classList.toggle("active", focusMode);
  // モード切替はデフォルト状態を決め直す契機。手動開閉の意図はリセットする
  // （resetSummaryCollapsed内でDOM反映まで行う）
  resetSummaryCollapsed();
}

// push通知: 設定ウィンドウでの変更をオーバーレイのボタン表示へ即反映する
api.onFocusModeChanged((enabled) => applyFocusMode(enabled));
api.onFontScaleChanged((scale) => applyFontScale(scale));

// projectDir/meetingContext の初期表示は同じConfigState（値＋envLocked）を使うため、
// getConfig()のIPCは1回だけ呼び、両initへ渡す（起動時の往復を減らす）。
api.getConfig().then((state) => {
  initProjectDirInput(state);
  initContextBadge(state);
  applyFontScale(state.values.fontScale);
});
// 集中モードは非永続化（メイン画面ボタン専用）のため、起動時は常にOFFから開始する
applyFocusMode(false);

function resetHistory() {
  history = [];
  cursor = -1;
  hasUnseenLatest = false;
  liveDraft = null;
  resetSummaryCollapsed(); // DOM反映まで含めて行う（resetSummaryCollapsed参照）
  updateHistoryNav();
}

function goToHistory(index) {
  if (history.length === 0) return;
  const clamped = Math.max(0, Math.min(index, history.length - 1));
  if (clamped === cursor) return;
  cursor = clamped;
  const isLatest = cursor === history.length - 1;
  const entry = history[cursor];
  if (isLatest && liveDraft && liveDraft.meetingFile === entry.meetingFile) {
    // 過去閲覧中に届いていたliveDraftの部分結果を最新完成品へ重ねて描画する。
    // liveDraftの未到着パートはundefinedのままなので、届いた(undefinedでない)パートのみ上書きする
    el.empty.hidden = true;
    renderBlocks(mergeLiveDraft(entry.suggestion, liveDraft));
    renderFooter(entry);
  } else {
    render(entry);
  }
  if (isLatest) {
    hasUnseenLatest = false;
  }
  updateHistoryNav();
}

/** 完成品(suggestion)に liveDraft の「届いたパートのみ」を重ねた合成オブジェクトを作る */
function mergeLiveDraft(suggestion, draft) {
  return {
    ...suggestion,
    ...draft.summary,
    ...(draft.web && { web: draft.web }),
    ...(draft.code && { code: draft.code }),
  };
}

function updateHistoryNav() {
  const total = history.length;
  const current = total === 0 ? 0 : cursor + 1;
  el.historyPosition.textContent = `${current} / ${total}`;
  el.historyPrevBtn.disabled = total <= 1 || cursor <= 0;
  el.historyNextBtn.disabled = total <= 1 || cursor >= total - 1;
  el.historyUnseen.hidden = !hasUnseenLatest;
}

function renderTopic(s) {
  // topicBlock表示時（topic/discussionのどちらかがある時）は見出しを常に非空にする
  // （スクリーンリーダー向けに空見出しを避けるため。s.discussionのみのケースのフォールバック）
  el.topic.textContent = s.topic || (s.discussion ? "話題" : "");
  el.discussion.textContent = s.discussion || "";
  el.topicBlock.hidden = !(s.topic || s.discussion);
  if (!summaryCollapsedTouched) summaryCollapsed = focusMode;
  applySummaryCollapsed();
}

function renderQuestions(s) {
  el.questions.replaceChildren();
  if (Array.isArray(s.questions) && s.questions.length > 0) {
    for (const q of s.questions) {
      const li = document.createElement("li");
      li.textContent = q;
      el.questions.appendChild(li);
    }
    el.questionsBlock.hidden = false;
  } else {
    el.questionsBlock.hidden = true;
  }
}

function renderWeb(s) {
  hideTooltip();
  el.web.replaceChildren();
  if (Array.isArray(s.web) && s.web.length > 0) {
    for (const w of s.web) {
      const item = document.createElement("div");
      item.className = "web-item";
      const title = createLinkableElement("web-title", "web-link", w.url);
      title.textContent = w.title;
      const detail = document.createElement("div");
      detail.className = "web-detail";
      detail.textContent = w.detail;
      item.append(title, detail);
      el.web.appendChild(item);
    }
    el.webBlock.hidden = false;
  } else {
    el.webBlock.hidden = true;
  }
}

function renderCode(s) {
  el.code.replaceChildren();
  if (Array.isArray(s.code) && s.code.length > 0) {
    for (const c of s.code) {
      const item = document.createElement("div");
      item.className = "code-item";
      const title = document.createElement("div");
      title.className = "code-title";
      title.textContent = c.title;
      const detail = document.createElement("div");
      detail.className = "code-detail";
      detail.textContent = c.detail;
      item.append(title, detail);
      if (c.ref) {
        const ref = createLinkableElement("code-ref", "code-link", c.url);
        ref.textContent = c.ref;
        item.appendChild(ref);
      }
      el.code.appendChild(item);
    }
    el.codeBlock.hidden = false;
  } else {
    el.codeBlock.hidden = true;
  }
}

function renderFooter(u) {
  const time = new Date(u.updatedAt).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const secs = (u.durationMs / 1000).toFixed(1);
  const cost = u.cumulativeCostUsd.toFixed(4);
  el.footerStatus.textContent = `Updated ${time} · ${secs}s · ~$${cost}`;
}

function renderBlocks(s) {
  renderTopic(s);
  renderQuestions(s);
  renderWeb(s);
  renderCode(s);
}

function render(u) {
  el.empty.hidden = true;
  renderBlocks(u.suggestion);
  renderFooter(u);
}

function truncate(str, n) {
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

let tooltipRect = null; // 表示中はサイズ不変なのでmousemove毎の強制リフローを避けるためキャッシュ

function showTooltip(url, e) {
  el.urlTooltip.textContent = url;
  el.urlTooltip.hidden = false;
  tooltipRect = el.urlTooltip.getBoundingClientRect();
  positionTooltip(e);
}

function positionTooltip(e) {
  // マウス右下に少しオフセット。右端・下端でウィンドウ外にはみ出す場合は反転
  const pad = 12;
  const rect = tooltipRect;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + rect.width > window.innerWidth) x = e.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight) y = e.clientY - rect.height - pad;
  el.urlTooltip.style.left = `${Math.max(4, x)}px`;
  el.urlTooltip.style.top = `${Math.max(4, y)}px`;
}

function hideTooltip() {
  el.urlTooltip.hidden = true;
}

/**
 * url があれば自前ツールチップ(URL表示)付きの<a>を、無ければ<div>を作る。
 * FROM THE WEB / FROM THE CODE の両方でリンク化ロジックを共通化するためのヘルパー。
 * ネイティブtitle属性はオーバーレイの背後に隠れるため自前ツールチップで表示する。
 */
function createLinkableElement(baseClassName, linkClassName, url) {
  if (!url) {
    const div = document.createElement("div");
    div.className = baseClassName;
    return div;
  }
  const a = document.createElement("a");
  a.className = `${baseClassName} ${linkClassName}`;
  a.href = "#";
  a.addEventListener("mouseenter", (e) => showTooltip(url, e));
  a.addEventListener("mousemove", (e) => positionTooltip(e));
  a.addEventListener("mouseleave", hideTooltip);
  a.addEventListener("click", (e) => {
    e.preventDefault();
    api.openExternal(url);
  });
  return a;
}
