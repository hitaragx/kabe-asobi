// センサー調整の道具の通し確認（APIキー不要）。
// ハブ（模擬センサー）を起動し、MCP の調整の道具を順に呼んで、値の変更・保存・分析が動くかを見る。
//   npx tsx tools/tune-smoke.ts
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const FILE = "config/detector.json";
const BAK = `${FILE}.bak`;
const procs: ChildProcess[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "NG  "} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail).slice(0, 300)}`}`);
};
if (existsSync(FILE)) renameSync(FILE, BAK);
try {
  if (!existsSync("recordings/sample-hard.jsonl")) spawn("npx", ["tsx", "tools/make-sample.ts"], { stdio: "ignore" });
  procs.push(spawn("npx", ["tsx", "src/server/hub.ts", "--source", "sim"], { stdio: "ignore" }));
  for (let i = 0; i < 75; i++) {
    try {
      if ((await fetch("http://127.0.0.1:8787")).ok) break;
    } catch {}
    await wait(200);
  }
  while (!existsSync("recordings/sample-hard.jsonl")) await wait(200);
  await wait(500);
  const client = new Client({ name: "tune-smoke", version: "0" });
  await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/mcp/wall-server.ts"] }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
    const t = r.content.find((c) => c.type === "text")?.text ?? "";
    let json: any = t;
    try {
      json = JSON.parse(t);
    } catch {}
    return { json, isError: r.isError };
  };

  const t1 = await call("sensor_tuning");
  check("調整値を見る", typeof t1.json?.options?.clusterGap === "number" && typeof t1.json?.help?.lostMs === "string", t1.json?.options);
  const recs = await call("list_recordings");
  check("記録の一覧", Array.isArray(recs.json) && recs.json.some((r: { file: string }) => r.file.endsWith("sample-hard.jsonl")));
  const a0 = await call("analyze_recording", { file: "recordings/sample-hard.jsonl", quietSec: 10 });
  const a1 = await call("analyze_recording", { file: "recordings/sample-hard.jsonl", quietSec: 10, values: { clusterGap: 0.06 } });
  check("分析（いまの値）", a0.json?.truth?.recall >= 0.95, a0.json?.truth);
  check("分析（試しの値で比べられる）", a1.json?.truth?.extraDowns > a0.json?.truth?.extraDowns, { now: a0.json?.truth?.extraDowns, gap6: a1.json?.truth?.extraDowns });
  const bad = await call("analyze_recording", { file: "../etc/passwd" });
  check("recordings/ の外は読まない", bad.isError === true);
  const set = await call("sensor_tuning_set", { values: { lostMs: 90 } });
  check("値を変える", set.json?.options?.lostMs === 90);
  check("値が保存される", existsSync(FILE) && JSON.parse(readFileSync(FILE, "utf8")).lostMs === 90);
  const badSet = await call("sensor_tuning_set", { values: { nosuch: 1 } });
  check("知らない値は断る", badSet.isError === true);
  const rl = await call("sensor_relearn");
  check("背景を覚え直す", rl.json?.ok === true);
  await client.close();
} finally {
  for (const p of procs) p.kill("SIGTERM");
  if (existsSync(FILE)) unlinkSync(FILE);
  if (existsSync(BAK)) renameSync(BAK, FILE);
  console.log(failures === 0 ? "すべて合格" : `${failures} 件 不合格`);
  process.exitCode = failures === 0 ? 0 : 1;
}
