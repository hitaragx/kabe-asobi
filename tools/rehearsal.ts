// 本物の Claude での通しのリハーサル。
// ハブ（模擬センサー）・壁の画面・スマホ画面のサーバーを起動し、職員役の頼みごとを順に送って、
// かかった時間・費用・何をしたか・壁がどう変わったかを記録する。
//
//   npx tsx tools/rehearsal.ts "頼みごと1" "頼みごと2" ...
//
// 費用がかかる（.env の APIキーを使う）。結果は test-results/rehearsal-*.png と標準出力。

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { chromium } from "playwright";

const prompts = process.argv.slice(2);
if (!prompts.length) {
  console.log('使い方：npx tsx tools/rehearsal.ts "頼みごと" ...');
  process.exit(1);
}
const KEY = "rehearsal";
const procs: ChildProcess[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUp(url: string) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await wait(200);
  }
  throw new Error(`起動しません: ${url}`);
}

mkdirSync("test-results", { recursive: true });
mkdirSync("logs", { recursive: true });
const phoneLog = createWriteStream("logs/rehearsal-phone.log");
try {
  procs.push(spawn("npx", ["tsx", "src/server/hub.ts", "--source", "sim"], { stdio: "ignore" }));
  procs.push(spawn("npx", ["vite", "--port", "5173", "--strictPort"], { stdio: "ignore" }));
  const phone = spawn("npx", ["tsx", "src/server/phone.ts", "--key", KEY], { stdio: ["ignore", "pipe", "pipe"] });
  phone.stdout!.pipe(phoneLog);
  phone.stderr!.on("data", (d) => {
    phoneLog.write(d);
    for (const line of String(d).split("\n")) if (line.includes("assistant.init")) console.log(`  [読み込み] ${line.slice(0, 600)}`);
  });
  procs.push(phone);
  await waitUp("http://127.0.0.1:8787");
  await waitUp("http://127.0.0.1:5173");
  await waitUp("http://127.0.0.1:8790");

  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const wall = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await wall.goto("http://127.0.0.1:5173/?muted");
  await wait(2000);

  let total = 0;
  for (const [i, text] of prompts.entries()) {
    console.log(`\n[${i + 1}] 職員：${text}`);
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:8790/api/chat?k=${KEY}`, { method: "POST", body: JSON.stringify({ text }) });
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let reply = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const e = JSON.parse(buf.slice(0, k).replace(/^data: /, ""));
        buf = buf.slice(k + 2);
        const sec = ((Date.now() - t0) / 1000).toFixed(0).padStart(3);
        if (e.type === "step") console.log(`  ${sec}秒  ・${e.text}`);
        if (e.type === "text") reply += e.delta;
        if (e.type === "error") console.log(`  ${sec}秒  ✗ ${e.message}`);
        if (e.type === "done") {
          total += e.costUsd ?? 0;
          console.log(`  ${sec}秒  Claude：${(e.text || reply).trim()}`);
          console.log(`  → ${e.seconds.toFixed(0)}秒、$${(e.costUsd ?? 0).toFixed(3)}`);
        }
      }
    }
    await wait(1500);
    await wall.screenshot({ path: `test-results/rehearsal-${i + 1}.png` });
    const st = await wall.evaluate(() => (window as any).__kabe.stats());
    console.log(`  壁：${st.game}、エラー ${st.errors.length}件`);
  }
  console.log(`\n合計 $${total.toFixed(3)}`);
  await browser.close();
} finally {
  for (const p of procs) p.kill("SIGTERM");
  phoneLog.end();
}
