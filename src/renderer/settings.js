// 設定ウィンドウ。preload共用の window.kuroko 経由で config:get/set を往復する。
// （プレーンJS。tscの対象外なのでdistへコピーされる）

/** @type {import('../main/preload').KurokoApi} */
const api = window.kuroko;

const form = document.getElementById("form");
const saveBtn = document.getElementById("saveBtn");
const saveStatus = document.getElementById("saveStatus");

// 数値か・最小値は settings.html の input の type/min 属性を唯一の情報源とする
// （main側の正規化と二重管理しないため。最終的な範囲クランプはmainが行う）

let saveTimer = null;

init();

async function init() {
  const state = await api.getConfig();
  applyState(state);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await save();
  });
}

/** ConfigState を受け取りフォームへ反映する（初期化・保存後の上書き共通） */
function applyState(state) {
  for (const field of form.querySelectorAll(".field")) {
    const key = field.dataset.key;
    const input = field.querySelector("input");
    const badge = field.querySelector(".lock-badge");
    const value = state.values[key];

    if (input.type === "checkbox") {
      input.checked = value === true;
    } else {
      // 実効値を表示。myNameのundefinedは空文字に。
      input.value = value == null ? "" : String(value);
    }

    const locked = state.envLocked[key];
    input.disabled = locked;
    badge.hidden = !locked;
    field.classList.toggle("locked", locked);
  }
}

async function save() {
  clearStatus();

  // クライアント検証（数値/範囲）。エラーがあれば保存しない
  const payload = {};
  for (const field of form.querySelectorAll(".field")) {
    const key = field.dataset.key;
    const input = field.querySelector("input");
    if (input.disabled) continue; // env固定キーは送らない

    if (input.type === "checkbox") {
      payload[key] = input.checked;
    } else if (input.type === "number") {
      const min = Number(input.min || 1);
      const n = Number(input.value);
      if (!Number.isFinite(n) || n < min) {
        showError(`${labelOf(field)}は ${min} 以上の数値で入力してください`);
        input.focus();
        return;
      }
      payload[key] = Math.trunc(n);
    } else {
      payload[key] = input.value;
    }
  }

  saveBtn.disabled = true;
  try {
    const res = await api.setConfig(payload);
    // main でクランプ・正規化された実効値で表示を上書きする
    applyState(res.state);
    showSaved();
  } catch (err) {
    showError(`保存に失敗しました: ${err && err.message ? err.message : err}`);
  } finally {
    saveBtn.disabled = false;
  }
}

function labelOf(field) {
  const span = field.querySelector(".label");
  return span ? span.textContent : field.dataset.key;
}

function clearStatus() {
  if (saveTimer) clearTimeout(saveTimer);
  saveStatus.textContent = "";
  saveStatus.className = "save-status";
}

function showSaved() {
  saveStatus.textContent = "保存しました";
  saveStatus.className = "save-status ok";
  saveTimer = setTimeout(clearStatus, 2000);
}

function showError(msg) {
  saveStatus.textContent = msg;
  saveStatus.className = "save-status error";
}
