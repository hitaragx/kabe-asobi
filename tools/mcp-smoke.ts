// 壁サーバー（MCP）の通し確認。
// ハブ・画面を起動し、壁の画面をヘッドレスで開いたまま、MCP の道具を順に呼ぶ。
// 下書きを一時的に書き換えて「公開 → 前の版に戻す」まで確かめ、最後に元へ戻す。
//
//   npx tsx tools/mcp-smoke.ts

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";
import { tool, toolStdio } from "../src/shared/run.ts";

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

const DRAFT = "web/games/balloons.ts";
const LIVE = "web/live/balloons.ts";
const original = readFileSync(DRAFT, "utf8");
const originalLive = readFileSync(LIVE, "utf8");
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "NG  "} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail).slice(0, 300)}`}`);
};

try {
  procs.push(spawn(...tool("tsx", ["src/server/hub.ts", "--source", "sim"]), { stdio: "ignore" }));
  procs.push(spawn(...tool("vite", ["--port", "5173", "--strictPort"]), { stdio: "ignore" }));
  await waitUp("http://127.0.0.1:8787");
  await waitUp("http://127.0.0.1:5173");

  // 壁の画面（プロジェクターに映すブラウザの代わり）
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("http://127.0.0.1:5173/?muted&game=balloons");
  await wait(1500);

  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(new StdioClientTransport({
      ...toolStdio("tsx", ["src/mcp/wall-server.ts"]),
      // 確認用に壁に出した記録は、本物の記録（config/games-meta.json）に混ぜない
      env: { ...(process.env as Record<string, string>), KABE_GAMES_META: "test-results/games-meta-smoke.json" },
    }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
    const t = r.content.find((c) => c.type === "text")?.text;
    return { r, json: t ? (() => { try { return JSON.parse(t); } catch { return t; } })() : null };
  };

  const tools = await client.listTools();
  check("道具の一覧", tools.tools.length >= 10, tools.tools.map((t) => t.name));

  const st = await call("wall_status");
  check("wall_status", st.json?.wall?.game === "balloons", { game: st.json?.wall?.game, sensor: st.json?.hub?.sensor });

  const lg = await call("list_games");
  check("list_games", Array.isArray(lg.json?.games) && lg.json.games.length >= 2, lg.json?.files);

  const sp = await call("set_params", { id: "balloons", values: { size: 1.6 } });
  check("set_params", !sp.r.isError);
  const shot = await call("wall_screenshot");
  check("wall_screenshot", shot.r.content.some((c) => c.type === "image"));
  await call("reset_params", { id: "balloons" });
  await wait(1500);

  // 壊れた下書きは壁に出ない
  writeFileSync(DRAFT, original.replace("setup(ctx) {", "setup(ctx) {\n    throw new Error('わざと壊した');"));
  const bad = await call("publish_game", { id: "balloons", seconds: 2 });
  check("壊れた下書きは公開されない", bad.r.isError === true && readFileSync(LIVE, "utf8") === originalLive);

  // 正しい下書きは公開され、前の版に戻せる
  writeFileSync(DRAFT, original.replace('title: "ふうせんわり"', 'title: "ふうせんわり（テスト）"'));
  const pub = await call("publish_game", { id: "balloons", seconds: 2 });
  check("公開", pub.json?.published === true && pub.json?.shown === true, pub.json);
  const g2 = await call("list_games");
  check("壁に新しい版", g2.json?.games?.find((g: { id: string }) => g.id === "balloons")?.title === "ふうせんわり（テスト）");

  const rb = await call("rollback_game", { id: "balloons" });
  check("前の版に戻す", rb.json?.rolledBack === true && readFileSync(LIVE, "utf8") === originalLive, rb.json);

  const sw = await call("show_game", { id: "animal-band" });
  const pv = await call("previous_game");
  check("遊びの切り替えと戻し", !sw.r.isError && pv.json?.game === "balloons", pv.json?.game);

  await client.close();
  await browser.close();
} finally {
  writeFileSync(DRAFT, original);
  writeFileSync(LIVE, originalLive);
  for (const p of procs) p.kill("SIGTERM");
  console.log(failures === 0 ? "すべて合格" : `${failures} 件 不合格`);
  process.exitCode = failures === 0 ? 0 : 1;
}
