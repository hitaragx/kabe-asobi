// 本物のセンサーから記録する。  npm run record -- <名前> [--host 192.168.0.10]
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
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
const p = spawn(...tool("tsx", ["src/server/hub.ts", "--source", "lidar", "--record", file, ...process.argv.slice(3)]), {
  stdio: ["inherit", "pipe", "inherit"],
});

// ハブのログ（JSON）を、記録している人が読める言葉に直して出す
const started = Date.now();
let total = 0;
createInterface({ input: p.stdout! }).on("line", (l) => {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(l);
  } catch {
    console.log(l);
    return;
  }
  const sec = Math.round((Date.now() - started) / 1000);
  const at = `${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, "0")}秒`;
  switch (m.msg) {
    case "lidar.connect":
      console.log(`[${at}] センサーにつながりました。記録を始めます`);
      break;
    case "hub.stats": {
      const downs = Number(m.downs ?? 0);
      total += downs;
      console.log(`[${at}] 記録中：${m.recorded}回分のスキャン ／ この10秒の当たり ${downs}回（合計 ${total}回）`);
      break;
    }
    case "sensor.status":
      if (m.status === "lost") console.log(`[${at}] ※ センサーからスキャンが届きません（${m.detail ?? ""}）。電源と LAN ケーブルを確かめてください`);
      else if (m.status === "ok") console.log(`[${at}] センサーの様子：正常`);
      break;
    case "hub.stop":
      console.log(`[${at}] 記録を終えました：${m.recorded}回分のスキャン → ${file}`);
      break;
    case "hub.warn":
    case "hub.listen":
    case "hub.start":
    case "lidar.probe":
      break; // 記録には関係ない
    default:
      console.log(l);
  }
});
process.on("SIGINT", () => p.kill("SIGINT"));
p.on("exit", (code) => process.exit(code ?? 0));
