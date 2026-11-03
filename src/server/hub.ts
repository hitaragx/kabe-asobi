// ハブ：入力元 → 当たり検出 → 合わせ込み → WebSocket でブラウザへ配信。
//
// 使い方：
//   npx tsx src/server/hub.ts --source sim                    模擬センサー
//   npx tsx src/server/hub.ts --source sim --touches          手のタッチも混ぜる
//   npx tsx src/server/hub.ts --source replay --file recordings/x.jsonl
//   ... --record recordings/x.jsonl                           生のスキャンを記録する

import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import type { Homography } from "../input/calibration.ts";
import { Pipeline } from "../input/pipeline.ts";
import { HUB_PORT, type HubMessage } from "../shared/protocol.ts";
import { Recorder } from "./recorder.ts";
import { ReplaySource, type ScanSource, SimSource } from "./sources.ts";

const CALIBRATION_FILE = "config/calibration.json";
const LOST_AFTER_MS = 500;

const { values: args } = parseArgs({
  options: {
    source: { type: "string", default: "sim" },
    file: { type: "string" },
    record: { type: "string" },
    touches: { type: "boolean", default: false },
    players: { type: "string" },
    port: { type: "string", default: String(HUB_PORT) },
    "no-loop": { type: "boolean", default: false },
  },
});

function log(msg: string, extra: Record<string, unknown> = {}): void {
  // 構造化ログ（JSON Lines）。Claude が読んで状況を判断できるようにする
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}

function loadCalibration(): Homography | null {
  if (!existsSync(CALIBRATION_FILE)) return null;
  const j = JSON.parse(readFileSync(CALIBRATION_FILE, "utf8")) as { homography: Homography };
  return j.homography;
}

async function makeSource(): Promise<ScanSource> {
  switch (args.source) {
    case "sim":
      return new SimSource({ touches: args.touches, players: args.players ? Number(args.players) : undefined });
    case "replay": {
      if (!args.file) throw new Error("--file を指定してください");
      const r = new ReplaySource(args.file, !args["no-loop"]);
      await r.load();
      return r;
    }
    default:
      throw new Error(`未対応の入力元です: ${args.source}`);
  }
}

async function main(): Promise<void> {
  const source = await makeSource();
  // 合わせ込みの結果があればそれを使う。なければ、模擬センサーの正解を使う
  const saved = loadCalibration();
  const homography = saved ?? source.knownHomography;
  log("hub.start", {
    source: source.name,
    model: source.spec.model,
    calibration: saved ? "file" : homography ? "known" : "none",
  });
  if (!homography) log("hub.warn", { detail: "合わせ込みがまだです。/calibrate を実行してください" });

  const pipeline = new Pipeline(source.spec, { source: source.name, homography });
  const recorder = args.record
    ? new Recorder(args.record, { spec: source.spec, source: source.name, knownHomography: source.knownHomography })
    : null;

  const http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, source: source.name, clients: wss.clients.size }));
  });
  const wss = new WebSocketServer({ server: http });
  const broadcast = (m: HubMessage) => {
    const s = JSON.stringify(m);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
  };

  let sensor: "starting" | "ok" | "lost" = "starting";
  let lastScanAt = 0;
  const setSensor = (s: typeof sensor, detail?: string) => {
    if (s === sensor) return;
    sensor = s;
    log("sensor.status", { status: s, detail });
    broadcast({ kind: "status", sensor: s, source: source.name, detail });
  };

  wss.on("connection", (ws) => {
    log("client.connect", { clients: wss.clients.size });
    ws.send(JSON.stringify({ kind: "status", sensor, source: source.name } satisfies HubMessage));
  });

  let frames = 0;
  let downs = 0;
  await source.start((scan) => {
    lastScanAt = Date.now();
    recorder?.write(scan);
    const frame = pipeline.process(scan);
    if (pipeline.detector.isLearning) return;
    setSensor("ok");
    if (!frame) return;
    frames++;
    downs += frame.events.filter((e) => e.type === "down").length;
    broadcast({ kind: "frame", frame });
  });

  // センサーが止まったら知らせる（画面は待機状態に戻る）
  setInterval(() => {
    if (lastScanAt && Date.now() - lastScanAt > LOST_AFTER_MS) setSensor("lost", "スキャンが届きません");
  }, 200);
  // 10秒ごとに様子を記録する
  setInterval(() => {
    log("hub.stats", { frames, downs, clients: wss.clients.size, recorded: recorder?.count ?? 0 });
    frames = 0;
    downs = 0;
  }, 10000);

  http.listen(Number(args.port), "127.0.0.1", () => log("hub.listen", { port: Number(args.port) }));

  const shutdown = async () => {
    source.stop();
    await recorder?.close();
    log("hub.stop", { recorded: recorder?.count ?? 0 });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e: unknown) => {
  log("hub.error", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
