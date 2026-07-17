// 設定ウィンドウ。preload共用の window.kuroko 経由で config:get/set を往復する。
// （プレーンJS。tscの対象外なのでdistへコピーされる）

/** @type {import('../main/preload.cts').KurokoApi} */
const api = window.kuroko;

const form = document.getElementById("form");
const saveBtn = document.getElementById("saveBtn");
const saveStatus = document.getElementById("saveStatus");

// 数値か・最小値は settings.html の input の type/min 属性を唯一の情報源とする
// （main側の正規化と二重管理しないため。最終的な範囲クランプはmainが行う）

let saveTimer = null;

// push通知: オーバーレイ側での変更を設定ウィンドウへ即反映する。
// env固定中でも表示同期はしてよい（値は実効値なので整合する）。
// getConfig()の往復完了より前に登録することで、初回ロード中のbroadcastを取りこぼさない
// （renderer.js側の同期登録→getConfigで初期値適用、という順序と揃える）。
api.onFontScaleChanged((scale) => applyPushedValue("fontScale", scale));
api.onPanelOpacityChanged((v) => applyPushedValue("panelOpacity", v));

init();

async function init() {
  const state = await api.getConfig();
  applyState(state);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await save();
  });

  // range系フィールドはスライダー操作中にも%表示をその場で追従させる（保存前のプレビュー用途）
  for (const input of form.querySelectorAll('input[type="range"]')) {
    input.addEventListener("input", () => updateRangeOutput(input));
  }
}

/**
 * push通知（単一値）でフォームの該当フィールドだけを書き換える。
 * applyState はフォーム全体を ConfigState から再構築する前提のため、
 * 単一値のpushには流用できず、1フィールド分の反映処理（applyValueToInput）だけを共有する。
 */
function applyPushedValue(key, value) {
  const field = form.querySelector(`.field[data-key="${key}"]`);
  if (!field) return;
  applyValueToInput(field.querySelector("input, select"), value);
}

/**
 * 1個のinput/selectへ値を反映する。checkbox/select/その他の3分岐は
 * applyState（フォーム全体再構築）と applyPushedValue（単一値push）の両方から共通で使う。
 */
function applyValueToInput(input, value) {
  if (input.type === "checkbox") {
    input.checked = value === true;
  } else if (input.tagName === "SELECT") {
    selectMatchingOption(input, value);
  } else if (input.type === "range") {
    // 内部値(小数)→UI(%整数)。panelOpacity専用の変換（このファイルだけの関心事）
    input.value = String(toPercent(Number(value)));
    updateRangeOutput(input);
  } else {
    // 実効値を表示。値がundefinedの場合は空文字に。
    input.value = value == null ? "" : String(value);
  }
}

/**
 * option.valueは文字列なので、String(value)の書式ズレ（例: String(1.0)==="1"で
 * option value="1.0"と不一致になりselectedIndex=-1になる）を避けて数値比較で選択する。
 */
function selectMatchingOption(select, value) {
  const match = [...select.options].find(
    (opt) => Number(opt.value) === Number(value),
  );
  select.value = match ? match.value : "";
}

// panelOpacity専用: UI(%整数)と内部値(0.3〜0.9の小数)の変換。
// この変換はsettings.js（設定ウィンドウ）だけの関心事で、main/config/rendererは一貫して小数を扱う。
const toPercent = (v) => Math.round(v * 100);
const fromPercent = (p) => p / 100;

/** range inputの現在値表示(<output>)を更新する。フォーム構築時／スライダー操作中の両方から呼ぶ */
function updateRangeOutput(input) {
  const output = input.closest(".field")?.querySelector("output.range-value");
  if (output) output.textContent = `${input.value}%`;
}

/** ConfigState を受け取りフォームへ反映する（初期化・保存後の上書き共通） */
function applyState(state) {
  for (const field of form.querySelectorAll(".field")) {
    const key = field.dataset.key;
    const input = field.querySelector("input, select");
    const badge = field.querySelector(".lock-badge");

    applyValueToInput(input, state.values[key]);

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
    const input = field.querySelector("input, select");
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
    } else if (input.tagName === "SELECT") {
      // fontScaleのプリセットは数値。mainのnormalizeEditable(snapToPreset)側でも数値変換するが、
      // 文字列のまま送るとGUI再表示のString(value)比較がズレないよう明示的にNumber化する
      payload[key] = Number(input.value);
    } else if (input.type === "range") {
      // UI(%整数)→内部値(小数)。panelOpacity専用の変換
      payload[key] = fromPercent(Number(input.value));
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
    showError(`保存に失敗しました: ${err?.message ? err.message : err}`);
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
