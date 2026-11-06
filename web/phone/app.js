// スマホ画面の動き（ビルドなしで動く素の JavaScript）。
"use strict";

const $ = (id) => document.getElementById(id);
const chat = $("chat");
let state = { busy: false, games: [], game: null, pendingPlan: null };
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
/** 通信が切れて、会話を取り直す必要があるか */
let needReload = false;
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
  updatePlans();
  // 通信が切れていた間に終わった返事を取り直す
  if (needReload && !state.busy && !streaming) {
    needReload = false;
    loadHistory();
  }
}

// ---- 壁の今の画面（1.5秒ごと） ----
let snapLoading = false;
function refreshSnapshot() {
  if (snapLoading || document.hidden) return;
  snapLoading = true;
  const img = new Image();
  img.onload = () => {
    $("wall-img").src = img.src;
    // 枠を壁と同じ縦横の比にする（端の表示が切れないように）
    if (img.naturalWidth && img.naturalHeight) $("wall").style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
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
// 初めて開いたときの、頼み方の例（押すとそのまま頼める。作る前に案が出るので安心）
const EXAMPLES = [
  ["小さい子が多い日", "4歳くらいの子が10人います。ボールを当てて遊べるものを作って"],
  ["小学生だけの日", "小学生が12人。2チームに分かれて対戦できる遊びにして"],
  ["いろんな子がいる日", "車いすの子もいます。みんなで一緒に、手でタッチして遊べるものを"],
  ["季節の行事", "お月見の季節なので、うさぎが出てくる遊びを作って"],
];
function showHello() {
  chat.innerHTML = "";
  const box = el("div", "hello");
  box.append(el("b", "", "どんな遊びにしたいか、話しかけてください"));
  box.append(document.createTextNode("どんな子が何人くらいいるかを言うと、合った遊びを考えます。作る前に案を見せます。"));
  const list = el("div", "examples");
  for (const [label, text] of EXAMPLES) {
    const b = el("button");
    b.append(el("small", "", label), document.createTextNode(`「${text}」`));
    b.addEventListener("click", () => sendText(text));
    list.append(b);
  }
  box.append(list);
  chat.append(box);
  $("suggest").hidden = true;
}

// 作る前の案。「これで作って」を押すまで、Claude は作らない
function planCard(plan) {
  const card = el("div", "plan");
  card.dataset.plan = plan.id;
  card.append(el("div", "k", "この遊びを作ろうと思います"), el("h3", "", plan.title), el("p", "", plan.summary));
  const ul = el("ul");
  for (const p of plan.points || []) ul.append(el("li", "", p));
  card.append(ul);
  const row = el("div", "row");
  const fix = el("button", "", "なおしたい");
  const ok = el("button", "primary", "これで作って");
  fix.addEventListener("click", () => {
    $("text").placeholder = "どこを変えたいですか？（例：もっと簡単に）";
    $("text").focus();
  });
  ok.addEventListener("click", () => {
    state.pendingPlan = null;
    sendText("この案で作って", plan.id);
  });
  row.append(fix, ok);
  card.append(row);
  return card;
}
/** いま返事を待っている案だけ、ボタンを押せるようにする */
function updatePlans() {
  for (const card of chat.querySelectorAll(".plan")) {
    const live = card.dataset.plan === state.pendingPlan && !streaming;
    card.querySelector(".row").hidden = !live;
  }
}

function addReply(turn) {
  if (turn.steps?.length) {
    const s = el("div", "steps");
    for (const t of turn.steps) s.append(el("span", "", `✓ ${t}`));
    chat.append(s);
  }
  if (turn.error) chat.append(el("div", "msg ai err", `うまくいきませんでした。もう一度言ってみてください。\n（${turn.error}）`));
  else if (turn.text) chat.append(el("div", "msg ai", turn.text));
  if (turn.plan) chat.append(planCard(turn.plan));
  if (turn.seconds) chat.append(el("div", "meta", `${Math.round(turn.seconds)}秒`));
  scrollDown();
}
async function loadHistory() {
  const h = await api("/api/history");
  chat.innerHTML = "";
  if (!h.length) return showHello();
  $("suggest").hidden = false;
  for (const t of h) t.role === "staff" ? addMe(t.text) : addReply(t);
  updatePlans();
}

function setBusy(b) {
  const send = $("send");
  send.textContent = b ? "■" : "➤";
  send.classList.toggle("stop", b);
  send.setAttribute("aria-label", b ? "止める" : "送る");
  for (const id of ["btn-back", "btn-games"]) $(id).disabled = b;
}

async function sendText(text, approve) {
  text = text.trim();
  if (!text || streaming) return;
  streaming = true;
  setBusy(true);
  $("suggest").hidden = false;
  $("text").placeholder = "こんな遊びにしたい…";
  addMe(text);
  updatePlans();
  const steps = el("div", "steps");
  const bubble = el("div", "msg ai");
  chat.append(steps);
  let current = null;
  let plan = null;
  // 通信が切れたとき（スマホがスリープした・Wi-Fi が途切れた）。Claude は PC 側で作業を続けている
  const lost = () => {
    if (current) current.className = "";
    chat.append(el("div", "msg ai err", "通信が切れました。Claude は作業を続けています。しばらくして画面を開き直すと、続きが見られます"));
    needReload = true;
  };
  let r;
  try {
    r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, approve }) });
  } catch {
    lost();
    streaming = false;
    setBusy(false);
    refreshState();
    return;
  }
  if (!r.ok || !r.body) {
    const e = await r.json().catch(() => ({}));
    chat.append(el("div", "msg ai err", e.error || "送れませんでした"));
    streaming = false;
    setBusy(false);
    refreshState();
    return;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
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
      } else if (e.type === "plan") {
        plan = e.plan;
      } else if (e.type === "done") {
        if (current) current.className = "";
        for (const s of steps.children) if (!s.textContent.startsWith("✓")) s.textContent = `✓ ${s.textContent}`;
        if (e.text) bubble.textContent = e.text;
        if (!bubble.isConnected && bubble.textContent) chat.append(bubble);
        if (plan) chat.append(planCard(plan));
        chat.append(el("div", "meta", `${Math.round(e.seconds)}秒`));
      } else if (e.type === "error") {
        if (current) current.className = "";
        chat.append(el("div", "msg ai err", `うまくいきませんでした。もう一度言ってみてください。\n（${e.message}）`));
      }
      scrollDown();
    }
  }
  } catch {
    lost();
  }
  streaming = false;
  if (plan) state.pendingPlan = plan.id;
  setBusy(false);
  updatePlans();
  refreshState();
  refreshSnapshot();
}

$("form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  // ■：この画面で送った作業でも、開き直したあと（別の端末）でも止められる
  if (streaming || state.busy) {
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
  $("sheet").scrollTop = 0;
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
// パソコンでは Esc で閉じる
document.addEventListener("keydown", (e) => e.key === "Escape" && !$("sheet").hidden && closeSheet());

// ---- 遊びの一覧・詳しい画面・きろく ----
const KIND = { new: "作った", update: "直した", rollback: "前の版に戻した" };
function when(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function day(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
async function showOnWall(id) {
  await api("/api/action", { action: "load", id });
  closeSheet();
  refreshState();
  setTimeout(refreshSnapshot, 300);
}
function madeText(g) {
  if (!g.createdAt) return "はじめから入っている遊び";
  const c = `${day(g.createdAt)} に作った`;
  return g.updatedAt && day(g.updatedAt) !== day(g.createdAt) ? `${c}（${day(g.updatedAt)} に直した）` : c;
}

function showGames() {
  const list = el("div");
  for (const g of state.games) {
    const row = el("div", `game${g.id === state.game ? " current" : ""}`);
    const left = el("div");
    left.append(el("b", "", g.title), el("small", "", `${g.ages}・${g.rule}`), el("span", "when", madeText(g)));
    left.addEventListener("click", () => showGame(g.id));
    row.append(left);
    if (g.id === state.game) row.append(el("span", "now", "いま"));
    else {
      const go = el("button", "go", "出す");
      go.addEventListener("click", () => showOnWall(g.id));
      row.append(go);
    }
    list.append(row);
  }
  list.append(el("div", "empty", "遊びの名前を押すと、どの頼みごとから作ったか、なぜその遊びにしたかが見られます"));
  openSheet("遊びをえらぶ", list);
}

function showGame(id, back = showGames) {
  const g = state.games.find((x) => x.id === id);
  if (!g) return;
  const box = el("div", "detail");
  box.append(el("h3", "", g.title), el("div", "sub", `${g.ages}・${g.rule}　${madeText(g)}`));
  const row = el("div", "actions-row");
  const backBtn = el("button", "", "‹ もどる");
  backBtn.addEventListener("click", back);
  row.append(backBtn);
  if (g.id !== state.game) {
    const go = el("button", "primary", "この遊びを壁に出す");
    go.addEventListener("click", () => showOnWall(g.id));
    row.append(go);
  }
  box.append(row);
  if (!g.versions.length) box.append(el("div", "empty", "はじめから入っている遊びなので、頼みごとの記録はありません"));
  for (const v of g.versions) {
    const ver = el("div", `ver ${v.kind}`);
    ver.append(el("div", "t", `${when(v.at)}　${KIND[v.kind] ?? ""}`));
    ver.append(el("div", "q", v.request ? `「${v.request}」` : "（頼みごとの記録なし）"));
    if (v.reason && v.kind !== "rollback") {
      const why = el("div", "why");
      why.append(el("b", "", "Claude がこうした理由"), document.createTextNode(v.reason));
      ver.append(why);
    }
    box.append(ver);
  }
  openSheet("遊びのくわしいこと", box);
}

async function showLog() {
  await refreshState();
  const reqs = await api("/api/requests");
  const list = el("div");
  if (!reqs.length) list.append(el("div", "empty", "まだ頼みごとはありません"));
  for (const r of reqs) {
    const card = el("div", `req${r.ok ? "" : " ng"}`);
    const t = el("div", "t");
    t.append(el("span", "", when(r.at)), el("span", "", [r.seconds ? `${Math.round(r.seconds)}秒` : "", r.costUsd ? `$${r.costUsd.toFixed(2)}` : ""].filter(Boolean).join("・")));
    card.append(t, el("div", "q", `「${r.request}」`), el("div", "a", r.reply));
    if (r.games.length) {
      const tags = el("div", "tags");
      for (const x of r.games) {
        const g = state.games.find((y) => y.id === x.id);
        const b = el("button", "", `${KIND[x.kind] ?? ""}：${g ? g.title : x.id} ›`);
        b.addEventListener("click", () => showGame(x.id, showLog));
        tags.append(b);
      }
      card.append(tags);
    }
    list.append(card);
  }
  openSheet("きろく（これまでの頼みごと）", list);
}

// ---- おと（音楽・効果音の大きさ、曲の雰囲気） ----
let lastMusic = 4;
async function setAudio(body) {
  const r = await api("/api/action", { action: "audio", ...body });
  if (!r.ok) alert(r.error || "変えられませんでした");
  return r;
}
function volumeRow(label, key, value, onChange) {
  const box = el("div", "vol");
  const head = el("div", "head");
  const num = el("span", "", String(value));
  head.append(el("b", "", label), num);
  const row = el("div", "row");
  const minus = el("button", "", "−");
  const plus = el("button", "", "＋");
  const range = el("input");
  range.type = "range";
  range.min = "0";
  range.max = "10";
  range.step = "1";
  range.value = String(value);
  let timer = null;
  const apply = (v, now) => {
    v = Math.max(0, Math.min(10, v));
    range.value = String(v);
    num.textContent = v === 0 ? "消音" : String(v);
    clearTimeout(timer);
    timer = setTimeout(() => onChange(v), now ? 0 : 250);
  };
  num.textContent = value === 0 ? "消音" : String(value);
  range.addEventListener("input", () => apply(Number(range.value), false));
  minus.addEventListener("click", () => apply(Number(range.value) - 1, true));
  plus.addEventListener("click", () => apply(Number(range.value) + 1, true));
  row.append(minus, range, plus);
  const ends = el("div", "ends");
  ends.append(el("span", "", "小さい"), el("span", "", "大きい"));
  box.append(head, row, ends);
  box.dataset.key = key;
  box.set = (v) => apply(v, true);
  return box;
}

async function showSound() {
  await refreshState();
  const a = state.audio || { music: 4, sfx: 6 };
  if (a.music > 0) lastMusic = a.music;
  const box = el("div");
  const musicRow = volumeRow("音楽（BGM）", "music", a.music, (v) => {
    if (v > 0) lastMusic = v;
    mute.textContent = v === 0 ? "音楽を流す" : "音楽を止める";
    setAudio({ music: v });
  });
  const mute = el("button", "mute", a.music === 0 ? "音楽を流す" : "音楽を止める");
  mute.addEventListener("click", () => musicRow.set(Number(musicRow.querySelector("input").value) === 0 ? lastMusic : 0));
  musicRow.append(mute);
  box.append(musicRow);
  box.append(volumeRow("効果音（当たったときの音）", "sfx", a.sfx, (v) => setAudio({ sfx: v })));

  const g = state.games.find((x) => x.id === state.game);
  if (g && state.musicStyles) {
    const st = el("div", "vol");
    st.append(el("div", "head"));
    st.firstChild.append(el("b", "", `いまの遊びの曲（${g.title}）`));
    const chips = el("div", "styles");
    for (const [key, label] of Object.entries(state.musicStyles)) {
      const b = el("button", key === g.music ? "on" : "", label);
      b.addEventListener("click", async () => {
        for (const c of chips.children) c.classList.remove("on");
        b.classList.add("on");
        g.music = key;
        await setAudio({ id: g.id, style: key });
      });
      chips.append(b);
    }
    st.append(chips);
    box.append(st);
  }
  box.append(el("div", "note", "音の大きさは、すべての遊びで同じです。Claude に「音楽を小さくして」と頼んでも変えられます。"));
  openSheet("おと", box);
}
// ---- そのほか（毎日は使わないもの） ----
function showMore() {
  const box = el("div", "menu");
  const item = (icon, label, note, fn, disabled) => {
    const b = el("button");
    const t = el("div");
    t.append(document.createTextNode(label), el("small", "", note));
    b.append(el("span", "", icon), t);
    b.disabled = Boolean(disabled);
    b.addEventListener("click", fn);
    box.append(b);
  };
  const busyNow = streaming || state.busy;
  item("🔊", "おと", "音楽と効果音の大きさ、曲の雰囲気", showSound);
  item("📒", "きろく", "これまでの頼みごとと、作った遊び", showLog);
  item("🎯", "壁に合わせる", "プロジェクターを動かしたとき（5分ほど）", startCalib, busyNow);
  item("💬", "新しい会話にする", "Claude との話を、はじめからにする", async () => {
    if (!confirm("いままでの話を消して、はじめからにしますか？（作った遊びは消えません）")) return;
    const r = await api("/api/reset", {});
    if (r.error) return alert(r.error);
    closeSheet();
    state.pendingPlan = null;
    showHello();
  }, busyNow);
  openSheet("そのほか", box);
}
$("btn-more").addEventListener("click", async () => {
  await refreshState();
  showMore();
});

$("btn-games").addEventListener("click", async () => {
  await refreshState();
  showGames();
});
async function startCalib() {
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
}

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
    // 言い終わったら、文を確かめてから ➤ で送ってもらう（聞き取りが途中で止まっても、そのまま送られないように）
    $("mic").classList.remove("on");
    if ($("text").value.trim()) {
      $("text").placeholder = "よければ ➤ を押してください";
      $("send").focus();
    }
  };
  rec.start();
});

// ---- はじめ ----
loadHistory();
refreshState();
refreshSnapshot();
setInterval(refreshState, 3000);
setInterval(refreshSnapshot, 1500);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  // スリープから戻ったとき：送っている途中でなければ、会話を取り直す（切れていた間の返事を出す）
  if (!streaming) loadHistory();
  refreshState();
  refreshSnapshot();
});
