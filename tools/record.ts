// 本物のセンサーから記録する。  npm run record -- <名前> [--host 192.168.0.10]
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tool } from "../src/shared/run.ts";

const name = process.argv[2];
if (!name || name.startsWith("-")) {
  console.log("使い方：npm run record -- <名前>（例：2026-11-06-a）");
  process.exit(1);
}
const file = `recordings/${name}.jsonl`;
if (existsSync(file)) {
  console.log(`すでにあります：${file}。別の名前にしてください`);
  process.exit(1);
}
console.log(`記録します：${file}（止めるときは Ctrl+C）`);
const p = spawn(...tool("tsx", ["src/server/hub.ts", "--source", "lidar", "--record", file, ...process.argv.slice(3)]), { stdio: "inherit" });
process.on("SIGINT", () => p.kill("SIGINT"));
p.on("exit", (code) => process.exit(code ?? 0));
