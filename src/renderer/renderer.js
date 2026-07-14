// レンダラ。preloadが公開する window.kuroko 経由でメインからイベントを受け取り、
// 提案パネルを描画する。（プレーンJS。tscの対象外なのでdistへコピーされる）

/** @type {import('../main/preload').KurokoApi} */
const api = window.kuroko;

const el = {
  statusDot: document.getElementById("statusDot"),
  statusLine: document.getElementById("statusLine"),
  empty: document.getElementById("empty"),
  topicBlock: document.getElementById("topicBlock"),
  topic: document.getElementById("topic"),
  discussion: document.getElementById("discussion"),
  questionsBlock: document.getElementById("questionsBlock"),
  questions: document.getElementById("questions"),
  webBlock: document.getElementById("webBlock"),
  web: document.getElementById("web"),
  footer: document.getElementById("footer"),
  footerStatus: document.getElementById("footerStatus"),
  refreshBtn: document.getElementById("refreshBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  historyPrevBtn: document.getElementById("historyPrevBtn"),
  historyNextBtn: document.getElementById("historyNextBtn"),
  historyPosition: document.getElementById("historyPosition"),
  historyUnseen: document.getElementById("historyUnseen"),
  urlTooltip: document.getElementById("urlTooltip"),
};

// 同一会議中のみ保持する提案履歴
let history = [];
let cursor = -1; // history.length - 1 = 最新を表示中
let hasUnseenLatest = false;

el.refreshBtn.addEventListener("click", () => api.triggerNow());
el.settingsBtn.addEventListener("click", () => api.openSettings());
el.historyPrevBtn.addEventListener("click", () => goToHistory(cursor - 1));
el.historyNextBtn.addEventListener("click", () => goToHistory(cursor + 1));
el.historyUnseen.addEventListener("click", () => goToHistory(history.length - 1));

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

  if (wasViewingLatest) {
    cursor = history.length - 1;
    render(u);
  } else {
    hasUnseenLatest = true;
  }
  updateHistoryNav();
});

api.onClickThrough((enabled) => {
  document.body.classList.toggle("click-through", enabled);
});

function resetHistory() {
  history = [];
  cursor = -1;
  hasUnseenLatest = false;
  updateHistoryNav();
}

function goToHistory(index) {
  if (history.length === 0) return;
  const clamped = Math.max(0, Math.min(index, history.length - 1));
  if (clamped === cursor) return;
  cursor = clamped;
  render(history[cursor]);
  if (cursor === history.length - 1) {
    hasUnseenLatest = false;
  }
  updateHistoryNav();
}

function updateHistoryNav() {
  const total = history.length;
  const current = total === 0 ? 0 : cursor + 1;
  el.historyPosition.textContent = `${current} / ${total}`;
  el.historyPrevBtn.disabled = total <= 1 || cursor <= 0;
  el.historyNextBtn.disabled = total <= 1 || cursor >= total - 1;
  el.historyUnseen.hidden = !hasUnseenLatest;
}

function render(u) {
  const s = u.suggestion;
  el.empty.hidden = true;

  // 話題 + 要約
  el.topic.textContent = s.topic || "";
  el.discussion.textContent = s.discussion || "";
  el.topicBlock.hidden = !(s.topic || s.discussion);

  // 聞くべきこと
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

  // FROM THE WEB
  hideTooltip();
  el.web.replaceChildren();
  if (Array.isArray(s.web) && s.web.length > 0) {
    for (const w of s.web) {
      const item = document.createElement("div");
      item.className = "web-item";
      let title;
      if (w.url) {
        title = document.createElement("a");
        title.className = "web-title web-link";
        title.href = "#";
        // ネイティブtitle属性はオーバーレイの背後に隠れるため自前ツールチップで表示
        title.addEventListener("mouseenter", (e) => showTooltip(w.url, e));
        title.addEventListener("mousemove", (e) => positionTooltip(e));
        title.addEventListener("mouseleave", hideTooltip);
        title.addEventListener("click", (e) => {
          e.preventDefault();
          api.openExternal(w.url);
        });
      } else {
        title = document.createElement("div");
        title.className = "web-title";
      }
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

  // フッター: 更新時刻 / 生成時間 / 累積コスト
  const time = new Date(u.updatedAt).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const secs = (u.durationMs / 1000).toFixed(1);
  const cost = u.cumulativeCostUsd.toFixed(4);
  el.footerStatus.textContent = `Updated ${time} · ${secs}s · ~$${cost}`;
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
