// ハブに接続して、指定秒数の間に届いたものを集計する（動作確認用）。
//   npx tsx tools/probe.ts [秒数]
import WebSocket from "ws";
import { HUB_PORT, type HubMessage } from "../src/shared/protocol.ts";

const seconds = Number(process.argv[2] ?? 5);
const ws = new WebSocket(`ws://127.0.0.1:${HUB_PORT}`);
let frames = 0, downs = 0, ups = 0, maxPoints = 0;
const latencies: number[] = [];
const statuses: string[] = [];
ws.on("message", (data) => {
  const m = JSON.parse(String(data)) as HubMessage;
  if (m.kind === "status") statuses.push(m.sensor);
  if (m.kind !== "frame") return;
  frames++;
  latencies.push(Date.now() - m.frame.t_capture);
  maxPoints = Math.max(maxPoints, m.frame.points.length);
  for (const e of m.frame.events) e.type === "down" ? downs++ : ups++;
});
ws.on("error", (e) => { console.error(JSON.stringify({ error: e.message })); process.exit(1); });
setTimeout(() => {
  latencies.sort((a, b) => a - b);
  console.log(JSON.stringify({
    seconds, frames, fps: +(frames / seconds).toFixed(1), downs, ups, maxPoints, statuses,
    latencyMs: { p50: latencies[Math.floor(latencies.length / 2)] ?? null, max: latencies.at(-1) ?? null },
  }));
  process.exit(0);
}, seconds * 1000);
