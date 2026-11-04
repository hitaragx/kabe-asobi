// 調整の練習・確認用の「わざと難しくした」模擬の記録を作る（本物のデータで起きそうな問題を入れる）。
//   npx tsx tools/make-sample.ts [出力先]   （既定：recordings/sample-hard.jsonl）
//
// 0〜12秒：誰もいない（背景を覚える＋誤反応を見る）
// 12〜42秒：3人がボールを当てる（合計は最後に表示）
// 20〜30秒：壁際に人が立つ（幅35cmの物が面に入る）
// ずっと：投影範囲の右外で、カーテンが揺れて出たり入ったりする
// ノイズは多め（本物に近づける）
import { Recorder } from "../src/server/recorder.ts";
import { Simulator, addRandomBalls } from "../src/input/sim/simulator.ts";

const out = process.argv[2] ?? "recordings/sample-hard.jsonl";
const sim = new Simulator({ seed: 77, noiseMm: 20, dropoutRate: 0.01 });
const balls = addRandomBalls(sim, { startMs: 12000, durationMs: 30000, players: 3, intervalMs: 1400, seed: 5 });
sim.add({ kind: "person", x: 0.6, y: 1.25, radius: 0.18, t0: 20000, t1: 30000 });
for (let t = 0; t < 45000; t += 1600) sim.add({ kind: "object", x: sim.wallWidth + 0.35, y: 0.9, radius: 0.12, t0: t, t1: t + 800 });

const epoch = Date.UTC(2026, 10, 4, 12, 0, 0);
const truth = balls.map((b) => ({ t: epoch + b.t0, ...sim.wallToScreen(b.x, b.y) }));
const rec = new Recorder(out, { spec: sim.spec, source: "sim-hard", knownHomography: sim.trueHomography(), truth });
let seq = 0;
for (let t = 0; t < 45000; t += sim.spec.scanPeriodMs) rec.write(sim.scanAt(t, seq++, epoch));
await rec.close();
console.log(JSON.stringify({ file: out, scans: rec.count, ballsThrown: balls.length, notes: "人が20〜30秒に壁際に立つ。カーテンが投影範囲の右外で揺れる" }));
