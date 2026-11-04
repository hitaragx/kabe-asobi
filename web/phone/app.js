// スマホ画面の動き（ビルドなしで動く素の JavaScript）。
"use strict";

const $ = (id) => document.getElementById(id);
const chat = $("chat");
let state = { busy: false, games: [], game: null };
let streaming = false;

// ---- 小道具 ----
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function scrollDown() {
  chat.scrollTop = chat.scrollHeight;
}

// ---- 状態（センサー・壁・いまの遊び） ----
async function refreshState() {
  try {
    state = await api("/api/state");
  } catch {
    return;
  }
  $("mode").hidden = state.assistant !== "mock";
  $("st-sensor").className = state.sensor === "ok" ? "ok" : "ng";
  $("st-wall").className = state.wallOpen ? "ok" : "ng";
  const g = state.games.find((x) => x.id === state.game);
  $("wall-title").textContent = g ? g.title : "—";
  $("wall-empty").hidden = state.wallOpen;
  setBusy(state.busy || streaming);
}

// ---- 壁の今の画面（1.5秒ごと） ----
let snapLoading = false;
function refreshSnapshot() {
  if (snapLoading || document.hidden) return;
  snapLoading = true;
  const img = new Image();
  img.onload = () => {
    $("wall-img").src = img.src;
    snapLoading = false;
  };
  img.onerror = () => (snapLoading = false);
  img.src = `/api/snapshot?t=${Date.now()}`;
}

// ---- 会話 ----
function addMe(text) {
  chat.querySelector(".hello")?.remove();
  chat.append(el("div", "msg me", text));
  scrollDown();
}
function addReply(turn) {
  if (turn.steps?.length) {
    const s = el("div", "steps");
    for (const t of turn.steps) s.append(el("span", "", `✓ ${t}`));
    chat.append(s);
  }
  if (turn.error) chat.append(el("div", "msg ai err", `うまくいきませんでした。もう一度言ってみてください。\n（${turn.error}）`));
  else if (turn.text) chat.append(el("div", "msg ai", turn.text));
  if (turn.seconds) chat.append(el("div", "meta", `${Math.round(turn.seconds)}秒`));
  scrollDown();
}
async function loadHistory() {
  const h = await api("/api/history");
  chat.innerHTML = "";
  if (!h.length) {
    chat.append(el("div", "hello", "どんな遊びにしたいか、話しかけてください。\n例：「4歳の子が10人。節分だから鬼にボールを当てる遊び」"));
    return;
  }
  for (const t of h) t.role === "staff" ? addMe(t.text) : addReply(t);
}

function setBusy(b) {
  const send = $("send");
  send.textContent = b ? "■" : "➤";
  send.classList.toggle("stop", b);
  send.setAttribute("aria-label", b ? "止める" : "送る");
  for (const id of ["btn-back", "btn-calib", "btn-games"]) $(id).disabled = b;
}

async function sendText(text) {
  text = text.trim();
  if (!text || streaming) return;
  streaming = true;
  setBusy(true);
  addMe(text);
  const steps = el("div", "steps");
  const bubble = el("div", "msg ai");
  chat.append(steps);
  let current = null;
  const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  if (!r.ok || !r.body) {
    const e = await r.json().catch(() => ({}));
    chat.append(el("div", "msg ai err", e.error || "送れませんでした"));
    streaming = false;
    setBusy(false);
    return;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i).replace(/^data: /, "");
      buf = buf.slice(i + 2);
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "step") {
        if (current) current.className = "";
        current = el("span", "now", e.text);
        steps.append(current);
      } else if (e.type === "text") {
        if (!bubble.isConnected) chat.append(bubble);
        bubble.textContent += e.delta;
      } else if (e.type === "done") {
        if (current) current.className = "";
        for (const s of steps.children) if (!s.textContent.startsWith("✓")) s.textContent = `✓ ${s.textContent}`;
        if (e.text) bubble.textContent = e.text;
        if (!bubble.isConnected && bubble.textContent) chat.append(bubble);
        chat.append(el("div", "meta", `${Math.round(e.seconds)}秒`));
      } else if (e.type === "error") {
        if (current) current.className = "";
        chat.append(el("div", "msg ai err", `うまくいきませんでした。もう一度言ってみてください。\n（${e.message}）`));
      }
      scrollDown();
    }
  }
  streaming = false;
  setBusy(false);
  refreshState();
  refreshSnapshot();
}

$("form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (streaming) {
    api("/api/stop", {});
    return;
  }
  const t = $("text").value;
  $("text").value = "";
  $("text").blur();
  sendText(t);
});
for (const b of $("suggest").querySelectorAll("button")) b.addEventListener("click", () => sendText(b.textContent));

// ---- ボタン ----
$("btn-back").addEventListener("click", async () => {
  const r = await api("/api/action", { action: "back" });
  if (!r.ok) alert(r.error || "戻せる遊びがありません");
  refreshState();
  refreshSnapshot();
});

function openSheet(title, body) {
  $("sheet-title").textContent = title;
  $("sheet-body").innerHTML = "";
  $("sheet-body").append(body);
  $("sheet").hidden = false;
  $("sheet-bg").hidden = false;
}
let calibTimer = null;
function closeSheet() {
  $("sheet").hidden = true;
  $("sheet-bg").hidden = true;
  if (calibTimer) clearInterval(calibTimer);
  calibTimer = null;
}
$("sheet-close").addEventListener("click", closeSheet);
$("sheet-bg").addEventListener("click", closeSheet);

$("btn-games").addEventListener("click", async () => {
  await refreshState();
  const list = el("div");
  for (const g of state.games) {
    const b = el("button", `game${g.id === state.game ? " current" : ""}`);
    const left = el("div");
    left.append(el("b", "", g.title), el("small", "", `${g.ages}・${g.rule}`));
    b.append(left, el("span", "", g.id === state.game ? "いま" : "›"));
    b.addEventListener("click", async () => {
      await api("/api/action", { action: "load", id: g.id });
      closeSheet();
      refreshState();
      setTimeout(refreshSnapshot, 300);
    });
    list.append(b);
  }
  openSheet("遊びをえらぶ", list);
});

$("btn-calib").addEventListener("click", async () => {
  const box = el("div", "calib");
  const big = el("div", "big", "準備しています…");
  const dots = el("div", "dots");
  const note = el("div", "", "壁に出た光る丸を、順に手でタッチして、少し押さえてください。");
  const cancel = el("button", "", "やめる");
  cancel.addEventListener("click", async () => {
    await api("/api/action", { action: "calibrate-cancel" });
    closeSheet();
  });
  box.append(big, dots, note, cancel);
  openSheet("壁に合わせる", box);
  const st = await api("/api/action", { action: "calibrate" });
  const show = (s) => {
    if (!s || !s.targets) return;
    big.textContent = s.message || "";
    dots.textContent = s.targets.map((t, i) => (t.captured ? "●" : i === s.active ? "◎" : "○")).join("");
    if (s.phase === "done" || s.phase === "failed") {
      clearInterval(calibTimer);
      calibTimer = null;
      cancel.textContent = "とじる";
      note.textContent = s.phase === "done" ? "これで、当たった場所と絵がそろいました。" : "もう一度「壁に合わせる」を押して、やり直してください。";
    }
  };
  show(st);
  calibTimer = setInterval(async () => show(await api("/api/action", { action: "calibrate-status" })), 700);
});

// ---- 話して頼む（使える端末だけ。使えなければキーボードのマイクを案内） ----
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
$("mic").addEventListener("click", () => {
  if (!SR) {
    $("text").focus();
    $("text").placeholder = "キーボードのマイクで話せます";
    return;
  }
  const rec = new SR();
  rec.lang = "ja-JP";
  rec.interimResults = true;
  $("mic").classList.add("on");
  rec.onresult = (e) => {
    $("text").value = Array.from(e.results).map((r) => r[0].transcript).join("");
  };
  rec.onerror = () => {
    $("text").focus();
    $("text").placeholder = "キーボードのマイクで話せます";
  };
  rec.onend = () => {
    $("mic").classList.remove("on");
    if ($("text").value.trim()) $("form").requestSubmit();
  };
  rec.start();
});

// ---- はじめ ----
loadHistory();
refreshState();
refreshSnapshot();
setInterval(refreshState, 3000);
setInterval(refreshSnapshot, 1500);
document.addEventListener("visibilitychange", () => !document.hidden && (refreshState(), refreshSnapshot()));
