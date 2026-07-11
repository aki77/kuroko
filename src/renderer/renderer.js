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
  refreshBtn: document.getElementById("refreshBtn"),
};

el.refreshBtn.addEventListener("click", () => api.triggerNow());

api.onStatus((s) => {
  el.statusDot.className = "dot";
  switch (s.kind) {
    case "no-meeting":
      el.statusDot.classList.add("idle");
      el.statusLine.textContent = "進行中の会議を待機中…";
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
  el.web.replaceChildren();
  if (Array.isArray(s.web) && s.web.length > 0) {
    for (const w of s.web) {
      const item = document.createElement("div");
      item.className = "web-item";
      const title = document.createElement("div");
      title.className = "web-title";
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
  el.footer.textContent = `Updated ${time} · ${secs}s · ~$${cost}`;
});

api.onClickThrough((enabled) => {
  document.body.classList.toggle("click-through", enabled);
});

function truncate(str, n) {
  return str.length > n ? `${str.slice(0, n)}…` : str;
}
