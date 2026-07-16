// 会議コンテキスト（アジェンダ・資料）専用ウィンドウ。
// meetingContextはmain側で非永続化（起動ごとに空へリセット）。専用context:summarize IPC経路で確定する。
// （プレーンJS。tscの対象外なのでdistへコピーされる）

/** @type {import('../main/preload.cts').KurokoApi} */
const api = window.kuroko;

const el = {
  input: document.getElementById("meetingContextInput"),
  file: document.getElementById("meetingContextFile"),
  fileLabel: document.getElementById("meetingContextFileLabel"),
  status: document.getElementById("contextStatus"),
  lockMessage: document.getElementById("contextLockMessage"),
};

function updateStatus() {
  el.status.textContent = el.input.value.trim() ? "登録済み" : "";
}

async function commitMeetingContext() {
  // 要約中の連打対策。要約中はinputをdisabledにするので、それを唯一のロック状態として再commitを弾く
  // （summarizeContextはclaude -pで数十秒かかりうる）。別フラグを持たず状態のソースを1つに保つ。
  if (el.input.disabled) return;
  const value = el.input.value;

  el.status.textContent = "要約中…";
  el.input.disabled = true;
  el.file.disabled = true;

  try {
    const res = await api.summarizeContext(value);
    if (res.summarized) {
      el.input.value = res.state.values.meetingContext || "";
    }
  } catch (err) {
    console.warn("failed to summarize meeting context:", err);
  } finally {
    el.input.disabled = false;
    el.file.disabled = false;
    updateStatus();
  }
}

function init(state) {
  const locked = state.envLocked.meetingContext === true;
  el.input.value = state.values.meetingContext || "";
  el.input.disabled = locked;
  el.fileLabel.hidden = locked;
  el.lockMessage.hidden = !locked;
  updateStatus();

  if (locked) return; // env固定時は編集不可なので保存/ファイル読込も不要

  el.input.addEventListener("change", commitMeetingContext);

  el.file.addEventListener("change", async () => {
    const file = el.file.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      el.input.value = text;
      await commitMeetingContext();
    } catch (err) {
      console.warn("failed to read meeting context file:", err);
    } finally {
      el.file.value = ""; // 同じファイルを連続選択しても change が発火するように
    }
  });
}

api.getConfig().then(init);
