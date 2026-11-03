// 自動検証：遊びをヘッドレスブラウザで開き、当たりを流して、エラー・FPS・画面を確かめる。
//
//   npx tsx tools/verify.ts [遊びのID ...] [--seconds 8] [--replay recordings/x.jsonl] [--draft]
//
// --draft を付けると、下書き（web/games）を確かめる。付けなければ壁の版（web/live）。
// 遊びのIDを省くと、すべての遊びを確かめる。
// 結果は JSON で出力し、スクリーンショットを test-results/<id>-*.png に保存する。
// 1つでも不合格なら終了コード 1。

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { HUB_PORT } from "../src/shared/protocol.ts";

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seconds: { type: "string", default: "8" },
    replay: { type: "string" },
    draft: { type: "boolean", default: false },
    width: { type: "string", default: "1280" },
    height: { type: "string", default: "800" },
    // ヘッドレスはGPUを使わないので低めに出る。実機のChromeでは60が目安
    "min-fps": { type: "string", default: "30" },
  },
});

const WEB_PORT = 5173;
const children: ChildProcess[] = [];

async function up(url: string): Promise<boolean> {
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}

async function waitUp(url: string, ms = 15000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await up(url)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`起動しませんでした: ${url}`);
}

function start(cmd: string, args: string[]): void {
  const p = spawn(cmd, args, { stdio: "ignore" });
  children.push(p);
}

interface Stats {
  game: string | null;
  fps: number;
  sensor: string;
  errors: { game: string; where: string; message: string }[];
  loadErrors: { file: string; message: string }[];
  history: string[];
  objects: number;
}

async function main(): Promise<void> {
  // すでに動いていればそれを使う
  if (!(await up(`http://127.0.0.1:${HUB_PORT}`))) {
    const src = opts.replay ? ["--source", "replay", "--file", opts.replay] : ["--source", "sim", "--touches"];
    start("npx", ["tsx", "src/server/hub.ts", ...src]);
    await waitUp(`http://127.0.0.1:${HUB_PORT}`);
  }
  if (!(await up(`http://127.0.0.1:${WEB_PORT}`))) {
    start("npx", ["vite", "--port", String(WEB_PORT), "--strictPort"]);
    await waitUp(`http://127.0.0.1:${WEB_PORT}`);
  }

  mkdirSync("test-results", { recursive: true });
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const viewport = { width: Number(opts.width), height: Number(opts.height) };
  const page = await browser.newPage({ viewport });
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => consoleErrors.push(e.message));
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  await page.goto(`http://127.0.0.1:${WEB_PORT}/?muted&debug${opts.draft ? "&draft" : ""}&attract=600000`);
  await page.waitForFunction(() => (window as unknown as { __kabe?: unknown }).__kabe !== undefined);
  const all = (await page.evaluate(() => (window as any).__kabe.games())) as { id: string; title: string }[];
  const targets = positionals.length ? positionals : all.map((g) => g.id);
  const known = new Set(all.map((g) => g.id));
  const seconds = Number(opts.seconds);
  const results = [];

  for (const id of targets) {
    consoleErrors.length = 0;
    const loaded = await page.evaluate((gid) => (window as any).__kabe.load(gid), id);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `test-results/${id}-start.png` });

    // 子どもが次々に当てる様子を模擬：画面のあちこちに当たりを起こす
    const before = (await page.evaluate(() => (window as any).__kabe.stats())) as Stats;
    const hits = Math.round(seconds * 3);
    for (let i = 0; i < hits; i++) {
      await page.evaluate(([x, y]) => (window as any).__kabe.hit(x, y), [0.1 + Math.random() * 0.8, 0.1 + Math.random() * 0.8]);
      if (i === Math.floor(hits / 2)) await page.screenshot({ path: `test-results/${id}-play.png` });
      await page.waitForTimeout((seconds * 1000) / hits);
    }
    const after = (await page.evaluate(() => (window as any).__kabe.stats())) as Stats;
    await page.screenshot({ path: `test-results/${id}-end.png` });

    const gameErrors = after.errors.filter((e) => e.game === id);
    const problems: string[] = [];
    for (const le of after.loadErrors.filter((e) => e.file.endsWith(`/${id}.ts`))) problems.push(`読み込みエラー: ${le.message}`);
    if (!known.has(id)) problems.push("遊びが登録されていません（ファイル名・id・export default を確認）");
    else if (!loaded) problems.push("読み込めませんでした");
    if (after.game !== id) problems.push(`別の遊びに戻されました（${after.game}）`);
    if (gameErrors.length) problems.push(...gameErrors.map((e) => `${e.where}: ${e.message}`));
    if (consoleErrors.length) problems.push(...consoleErrors.map((e) => `console: ${e}`));
    if (after.fps < Number(opts["min-fps"])) problems.push(`FPSが低い（${after.fps}）`);
    // 物が増え続けていないか（後片付け漏れ）
    if (after.objects > Math.max(400, before.objects * 4)) problems.push(`画面の物が増え続けています（${before.objects} → ${after.objects}）`);

    results.push({
      id,
      ok: problems.length === 0,
      fps: after.fps,
      objects: { before: before.objects, after: after.objects },
      problems,
      screenshots: [`test-results/${id}-start.png`, `test-results/${id}-play.png`, `test-results/${id}-end.png`],
    });
  }

  await browser.close();
  console.log(JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
  if (!results.every((r) => r.ok)) process.exitCode = 1;
}

main()
  .catch((e: unknown) => {
    console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  })
  .finally(() => {
    for (const c of children) c.kill("SIGTERM");
  });
