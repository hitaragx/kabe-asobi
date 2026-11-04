// 裏側の画面（動画用）。Claude の動きを時系列で大きく見せる。
"use strict";
const $ = (id) => document.getElementById(id);
const ICON = { model: "M", skill: "S", mcp: "W", subagent: "A", edit: "✎", read: "R", hook: "H", result: "✓" };

let current = null; // { id, prompt, startedAt, done }
const runs = new Map();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const money = (usd) => (usd === undefined ? "—" : `$${usd.toFixed(3)}`);

function addRow(e) {
  const r = el("div", `row k-${e.kind}${e.sub ? " sub" : ""}${e.kind === "result" ? (e.ok ? " ok" : " ng") : ""}`);
  r.append(el("div", "t", `${e.at.toFixed(1)}秒`));
  r.append(el("div", "ic", e.kind === "result" ? (e.ok ? "✓" : "✗") : ICON[e.kind] || "・"));
  const body = el("div");
  body.append(el("b", "", e.label));
  if (e.detail) body.append(el("div", "d", e.detail));
  r.append(body);
  $("rows").append(r);
  $("rows").scrollTop = $("rows").scrollHeight;
}

function count(run) {
  const c = { skill: 0, mcp: 0, subagent: 0, hook: 0 };
  for (const e of run.events) if (e.type === "trace" && e.kind in c) c[e.kind]++;
  return c;
}
function renderRuns() {
  const tb = $("runs");
  tb.innerHTML = "";
  for (const run of [...runs.values()].slice(-4)) {
    const c = count(run);
    const tr = el("tr");
    tr.append(el("td", "", run.prompt.length > 34 ? `${run.prompt.slice(0, 34)}…` : run.prompt));
    tr.append(el("td", "n", run.seconds === undefined ? "作業中" : `${Math.round(run.seconds)}秒`));
    tr.append(el("td", "n", money(run.costUsd)));
    for (const k of ["skill", "mcp", "subagent", "hook"]) tr.append(el("td", "n", String(c[k])));
    tb.append(tr);
  }
}

function start(run) {
  current = { ...run, done: false };
  runs.set(run.id, { ...run, events: [] });
  $("prompt").textContent = `「${run.prompt}」`;
  $("prompt").classList.remove("empty");
  $("rows").innerHTML = "";
  $("reply").textContent = "";
  $("reply-box").hidden = true;
  $("cost").textContent = "—";
  $("state").textContent = "作業中";
  $("state").className = "state busy";
  renderRuns();
}

function onEvent(runId, e) {
  const run = runs.get(runId);
  if (!run) return;
  if (e.type !== "text") run.events.push(e);
  if (e.type === "trace") addRow(e);
  if (e.type === "text") {
    $("reply-box").hidden = false;
    $("reply").textContent += e.delta;
  }
  if (e.type === "done") {
    Object.assign(run, { seconds: e.seconds, costUsd: e.costUsd });
    if (current && current.id === runId) {
      current.done = true;
      $("timer").textContent = fmt(e.seconds);
      $("cost").textContent = money(e.costUsd);
      $("state").textContent = "完了";
      $("state").className = "state done";
      if (e.text) {
        $("reply-box").hidden = false;
        $("reply").textContent = e.text;
      }
    }
  }
  if (e.type === "error" && current && current.id === runId) {
    current.done = true;
    $("state").textContent = `止まりました：${e.message}`;
    $("state").className = "state err";
  }
  renderRuns();
}

// 経過時間（作業中だけ進める）
setInterval(() => {
  if (current && !current.done) $("timer").textContent = fmt((Date.now() - current.startedAt) / 1000);
}, 200);

// 壁の今の画面
setInterval(() => {
  const img = new Image();
  img.onload = () => ($("wall").src = img.src);
  img.src = `/api/snapshot?t=${Date.now()}`;
}, 1000);

// これまでの分を読み込んでから、流れを受け取る
(async () => {
  const st = await fetch("/api/backstage/state").then((r) => r.json());
  if (st.assistant === "mock") $("mode").textContent = "仮の相手（APIキーなし）";
  for (const run of st.runs) {
    runs.set(run.id, run);
  }
  const last = st.runs[st.runs.length - 1];
  if (last) {
    start(last);
    for (const e of last.events) onEvent(last.id, e);
    if (last.seconds === undefined && st.busy) current.done = false;
  }
  renderRuns();
  const es = new EventSource("/api/backstage/stream");
  es.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.kind === "start") start(d.run);
    if (d.kind === "event") onEvent(d.runId, d.event);
  };
})();
