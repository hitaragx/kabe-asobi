// 合わせ込みの通し確認（模擬センサー）。
// 壁の画面を開き、MCP で合わせ込みを始め、模擬の手で丸を順にタッチして、合格まで進むかを見る。
//   npx tsx tools/calib-smoke.ts

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";
import { tool, toolStdio } from "../src/shared/run.ts";

const CAL = "config/calibration.json";
const BACKUP = "config/calibration.json.bak";
const procs: ChildProcess[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUp(url: string) {
  for (let i = 0; i < 75; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await wait(200);
  }
  throw new Error(`起動しません: ${url}`);
}
const touch = (x: number, y: number) => fetch("http://127.0.0.1:8787/api/sim/touch", { method: "POST", body: JSON.stringify({ x, y, ms: 1300 }) });

let ok = false;
if (existsSync(CAL)) renameSync(CAL, BACKUP);
try {
  procs.push(spawn(...tool("tsx", ["src/server/hub.ts", "--source", "sim", "--no-balls"]), { stdio: "ignore" }));
  procs.push(spawn(...tool("vite", ["--port", "5173", "--strictPort"]), { stdio: "ignore" }));
  await waitUp("http://127.0.0.1:8787");
  await waitUp("http://127.0.0.1:5173");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("http://127.0.0.1:5173/?muted&game=balloons");
  await wait(2000);

  const client = new Client({ name: "calib-smoke", version: "0" });
  await client.connect(new StdioClientTransport(toolStdio("tsx", ["src/mcp/wall-server.ts"])));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[] };
    return JSON.parse(r.content.find((c) => c.type === "text")!.text!);
  };

  let st = await call("calibrate_start");
  mkdirSync("test-results", { recursive: true });
  for (let i = 0; i < st.targets.length; i++) {
    const tg = st.targets[st.active];
    // 職員は丸の中心から少しずれてタッチする（1〜2cm 程度）
    await touch(tg.x + 0.005, tg.y - 0.006);
    await wait(500);
    if (i === 0) await page.screenshot({ path: "test-results/calibration-hold.png" });
    await wait(1400);
    st = await call("calibrate_status");
    console.log(`  ${i + 1}: phase=${st.phase} active=${st.active} ${st.message}`);
  }
  await page.screenshot({ path: "test-results/calibration-result.png" });
  console.log(JSON.stringify({ phase: st.phase, checkErrorsCm: st.checkErrorsCm, fitErrorsCm: st.fitErrorsCm }));
  ok = st.phase === "done" && existsSync(CAL);
  await client.close();
  await browser.close();
} finally {
  for (const p of procs) p.kill("SIGTERM");
  // 模擬センサーの合わせ込み結果は残さない（もとの結果があれば戻す）
  if (existsSync(CAL)) unlinkSync(CAL);
  if (existsSync(BACKUP)) renameSync(BACKUP, CAL);
  console.log(ok ? "合格" : "不合格");
  process.exitCode = ok ? 0 : 1;
}
