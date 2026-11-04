// 反応の遅れ（ソフトウェアの部分）を測る。
//
//   npm run latency                  … 動いているハブと壁の画面から読む（本番の構成のまま測る）
//   npm run latency -- --sim         … 模擬センサー・壁の画面を自分で起動して測る（センサーなしの確認用）
//   npm run latency -- --seconds 30  … 集める時間（既定 20 秒）
//
// 測れるのは「スキャンを受け取ってから、反応を描いた画面ができるまで」。
// センサーの中の時間と、プロジェクターが映すまでの時間は含まれないので、
// 全体はスローモーション撮影で確かめる（docs/latency.md）。

import { type ChildProcess, spawn } from "node:child_process";
import { chromium } from "playwright";
import { HUB_PORT } from "../src/shared/protocol.ts";

const args = process.argv.slice(2);
const sim = args.includes("--sim");
const si = args.indexOf("--seconds");
const seconds = si >= 0 ? Number(args[si + 1]) : 20;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Part = { p50: number | null; p95: number | null };
type Latency = { n: number; hub: Part; net: Part; frame: Part; total: Part };

async function up(url: string) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await wait(200);
  }
  throw new Error(`起動しません: ${url}`);
}

async function stats(): Promise<{ fps: number; sensor: string; latency?: Latency }> {
  const r = await fetch(`${HUB}/api/wall`, { method: "POST", body: JSON.stringify({ action: "stats" }) });
  const j = (await r.json()) as { ok: boolean; data?: any; error?: string };
  if (!j.ok) throw new Error(j.error ?? "壁の画面から返事がありません（壁の画面を開いていますか）");
  return j.data;
}

const procs: ChildProcess[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  if (sim) {
    procs.push(spawn("npx", ["tsx", "src/server/hub.ts", "--source", "sim"], { stdio: "ignore" }));
    procs.push(spawn("npx", ["vite", "--port", "5173", "--strictPort"], { stdio: "ignore" }));
    await up(HUB);
    await up("http://127.0.0.1:5173");
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto("http://127.0.0.1:5173/?muted");
  } else {
    try {
      await fetch(`${HUB}/api/status`);
    } catch {
      console.log("ハブが動いていません。`npm run dev:lidar`（または `npm run dev`）で起動してから測ってください。");
      console.log("センサーなしで試すときは `npm run latency -- --sim`。");
      process.exit(1);
    }
  }

  // 壁の画面は直近200件の当たりを覚えている。最後に読んだ値を使う
  console.log(`${seconds}秒、当たりを集めます。${sim ? "（模擬センサー）" : "壁にボールを当てる・手でタッチしてください。"}`);
  for (let s = 0; s < seconds; s += 5) {
    await wait(5000);
    const st = await stats().catch((e: Error) => ({ fps: 0, sensor: e.message, latency: undefined }));
    console.log(`  ${s + 5}秒  当たり ${st.latency?.n ?? 0}件  fps ${st.fps}  センサー ${st.sensor}`);
  }
  const st = await stats();
  const L = st.latency;
  if (!L || L.n === 0) {
    console.log("当たりが1件もありませんでした。");
    process.exit(1);
  }
  const f = (p: Part) => `中央 ${String(p.p50).padStart(3)}ms  遅い方(95%) ${String(p.p95).padStart(3)}ms`;
  console.log(`\n反応の遅れ（ソフトウェアの部分、${L.n}件）`);
  console.log(`  当たり検出・座標変換（ハブ）     ${f(L.hub)}`);
  console.log(`  ハブ → 壁の画面（WebSocket）     ${f(L.net)}`);
  console.log(`  遊びに届く → 画面ができる       ${f(L.frame)}`);
  console.log(`  合計                             ${f(L.total)}`);
  const scanMs = 25;
  const est = (L.total.p50 ?? 0) + scanMs / 2 + 1000 / 60 + 20;
  console.log(`\n全体の見込み（中央）：約 ${Math.round(est)}ms`);
  console.log(`  = 上の合計 ＋ センサーの1回転の半分（${scanMs / 2}ms）＋ 画面の書き換え1回（17ms）＋ プロジェクター（仮に20ms）`);
  console.log("  プロジェクターの分は機種で違うので、スローモーション撮影で確かめる（docs/latency.md）。");
} finally {
  await browser?.close();
  for (const p of procs) p.kill("SIGTERM");
}
