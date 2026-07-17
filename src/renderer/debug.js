// デバッグウィンドウ（開発・動作確認用）。
// main側のDebugLog（リングバッファ）から起動時にsnapshotを流し込み、以降はliveイベントを追記する。
// オーバーレイの既存Status/suggestion経路とは完全に独立（ここでの表示・フィルタ操作は他ウィンドウに影響しない）。
// （プレーンJS。tscの対象外なのでdistへコピーされる）

/** @type {import('../main/preload.cts').KurokoApi} */
const api = window.kuroko;

const el = {
  log: document.getElementById("log"),
  sourceFilter: document.getElementById("sourceFilter"),
  levelFilter: document.getElementById("levelFilter"),
  clearBtn: document.getElementById("clearBtn"),
};

/** 描画済み<li>を間引く上限。main側のリングバッファ(MAX_EVENTS)と同程度に揃え、二重に肥大化させない */
const MAX_RENDERED = 500;

function matchesFilter(ev) {
  if (el.sourceFilter.value && ev.source !== el.sourceFilter.value)
    return false;
  if (el.levelFilter.value && ev.level !== el.levelFilter.value) return false;
  return true;
}

function formatTime(at) {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleTimeString("ja-JP");
}

function createItem(ev) {
  const li = document.createElement("li");
  li.className = `debug-item level-${ev.level}`;

  const summary = document.createElement("div");
  summary.className = "debug-summary";

  const timeEl = document.createElement("span");
  timeEl.className = "debug-time";
  timeEl.textContent = formatTime(ev.at);

  const sourceEl = document.createElement("span");
  sourceEl.className = "debug-source";
  sourceEl.textContent = ev.source;

  const kindEl = document.createElement("span");
  kindEl.className = "debug-kind";
  kindEl.textContent = ev.kind;

  const messageEl = document.createElement("span");
  messageEl.className = "debug-message";
  messageEl.textContent = ev.message;

  summary.append(timeEl, sourceEl, kindEl, messageEl);
  li.appendChild(summary);

  if (ev.detail) {
    const details = document.createElement("details");
    const pre = document.createElement("pre");
    pre.textContent = ev.detail;
    details.appendChild(document.createElement("summary")).textContent = "詳細";
    details.appendChild(pre);
    li.appendChild(details);
  }

  return li;
}

function append(ev) {
  if (!matchesFilter(ev)) return;

  // ユーザーが上にスクロールして過去を読んでいる間はライブ追記で下に引っ張らない
  const atBottom =
    el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 40;

  el.log.appendChild(createItem(ev));

  while (el.log.children.length > MAX_RENDERED) {
    el.log.removeChild(el.log.firstElementChild);
  }

  if (atBottom) {
    el.log.scrollTop = el.log.scrollHeight;
  }
}

function rerenderAll(events) {
  const filtered = events.filter(matchesFilter).slice(-MAX_RENDERED);

  const fragment = document.createDocumentFragment();
  for (const ev of filtered) fragment.appendChild(createItem(ev));

  el.log.replaceChildren(fragment);
  el.log.scrollTop = el.log.scrollHeight;
}

let allEvents = [];

api.onDebugSnapshot((events) => {
  allEvents = events;
  rerenderAll(allEvents);
});

api.onDebugEvent((ev) => {
  allEvents.push(ev);
  if (allEvents.length > MAX_RENDERED) {
    allEvents = allEvents.slice(-MAX_RENDERED);
  }
  append(ev);
});

el.sourceFilter.addEventListener("change", () => rerenderAll(allEvents));
el.levelFilter.addEventListener("change", () => rerenderAll(allEvents));
el.clearBtn.addEventListener("click", () => {
  // 表示上のクリアのみ。main側のリングバッファは消さない（ウィンドウを再度開けば復元される）
  allEvents = [];
  el.log.textContent = "";
});
