// 模擬の SCIP 2.0 サーバー。本物のセンサーの代わりに、模擬スキャンを SCIP で流す。
// センサー接続まわり（再接続など）を、センサーなしで確かめるために使う。
//
//   npx tsx tools/fake-scip.ts [--port 10940] [--drop-after 秒] [--silent-after 秒]
//     --drop-after   接続を切る（切断からの再接続を試す）
//     --silent-after 接続は保ったまま黙り込む（ケーブル抜け・電源の入れ直しの再現。見張りによる再接続を試す）

import { createServer } from "node:net";
import { parseArgs } from "node:util";
import { UST_20LX } from "../src/input/scan.ts";
import { checksum, encode, SCIP_PORT } from "../src/input/scip.ts";
import { Simulator, addRandomBalls } from "../src/input/sim/simulator.ts";

const { values } = parseArgs({
  options: { port: { type: "string", default: String(SCIP_PORT) }, "drop-after": { type: "string" }, "silent-after": { type: "string" } },
});
const spec = UST_20LX;
const sim = new Simulator({ seed: 21 });
addRandomBalls(sim, { startMs: 1500, durationMs: 3600_000, players: 3, intervalMs: 1500 });
const t0 = Date.now();

const line = (s: string) => `${s}${checksum(s)}\n`;
const status = (s: string) => line(s);

function distanceBlock(echo: string, st: string, ranges: number[], ts: number): string {
  let out = `${echo}\n${status(st)}${line(encode(ts & 0xffffff, 4))}`;
  const data = ranges.map((r) => encode(Math.max(0, r), 3)).join("");
  for (let i = 0; i < data.length; i += 64) out += line(data.slice(i, i + 64));
  return `${out}\n`;
}

createServer((sock) => {
  console.log(JSON.stringify({ msg: "fake-scip.connect" }));
  let timer: NodeJS.Timeout | null = null;
  let buf = "";
  let silent = false;
  if (values["drop-after"]) setTimeout(() => sock.destroy(), Number(values["drop-after"]) * 1000);
  if (values["silent-after"]) setTimeout(() => (silent = true), Number(values["silent-after"]) * 1000);
  sock.on("data", (d) => {
    buf += d.toString("latin1");
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const cmd = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
      const head = cmd.slice(0, 2);
      if (head === "VV") {
        sock.write(`VV\n${status("00")}${["VEND:fake;", "PROD:fake-scip;", "FIRM:0.1;", "PROT:SCIP 2.0;", "SERI:0;"].map((s) => line(s)).join("")}\n`);
      } else if (head === "PP") {
        const p = ["MODL:UST-20LX(fake)", "DMIN:20", "DMAX:60000", "ARES:1440", "AMIN:0", "AMAX:1080", "AFRT:540", "SCAN:2400"];
        sock.write(`PP\n${status("00")}${p.map((s) => `${s};${checksum(`${s};`)}\n`).join("")}\n`);
      } else if (head === "BM" || head === "QT" || head === "RS") {
        if (timer) clearInterval(timer);
        timer = null;
        sock.write(`${cmd}\n${status("00")}\n`);
      } else if (head === "GD") {
        const start = Number(cmd.slice(2, 6));
        const end = Number(cmd.slice(6, 10));
        const t = Date.now() - t0;
        sock.write(distanceBlock(cmd, "00", sim.scanAt(t, 0).ranges.slice(start, end + 1), t));
      } else if (head === "MD") {
        const start = Number(cmd.slice(2, 6));
        const end = Number(cmd.slice(6, 10));
        sock.write(`${cmd}\n${status("00")}\n`);
        let seq = 0;
        if (timer) clearInterval(timer);
        timer = setInterval(() => {
          const t = Date.now() - t0;
          const s = sim.scanAt(t, seq++);
          sim.prune(t - 1000);
          if (!silent) sock.write(distanceBlock(cmd, "99", s.ranges.slice(start, end + 1), t));
        }, spec.scanPeriodMs);
      } else {
        sock.write(`${cmd}\n${status("0E")}\n`);
      }
    }
  });
  sock.on("close", () => {
    if (timer) clearInterval(timer);
    console.log(JSON.stringify({ msg: "fake-scip.close" }));
  });
  sock.on("error", () => {});
}).listen(Number(values.port), "127.0.0.1", () => console.log(JSON.stringify({ msg: "fake-scip.listen", port: Number(values.port), trueHomography: sim.trueHomography() })));
