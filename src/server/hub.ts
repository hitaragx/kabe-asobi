// ハブ：入力元 → 当たり検出 → 合わせ込み → WebSocket でブラウザへ配信。
//
// 使い方：
//   npx tsx src/server/hub.ts --source sim                    模擬センサー
//   npx tsx src/server/hub.ts --source sim --touches          手のタッチも混ぜる
//   npx tsx src/server/hub.ts --source replay --file recordings/x.jsonl
//   npx tsx src/server/hub.ts --source lidar --host 192.168.0.10     本物の測域センサ
//   ... --record recordings/x.jsonl                           生のスキャンを記録する

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type IncomingMessage, createServer } from "node:http";
import { parseArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import type { Homography } from "../input/calibration.ts";
import { Pipeline } from "../input/pipeline.ts";
import { type ClientMessage, HUB_PORT, type HubMessage, type WallAction } from "../shared/protocol.ts";
import { Recorder } from "./recorder.ts";
import { LidarSource, ReplaySource, type ScanSource, SimSource } from "./sources.ts";

const CALIBRATION_FILE = "config/calibration.json";
const PARAMS_FILE = "config/params.json";
const LOST_AFTER_MS = 500;

const { values: args } = parseArgs({
  options: {
    source: { type: "string", default: "sim" },
    file: { type: "string" },
    record: { type: "string" },
    touches: { type: "boolean", default: false },
    host: { type: "string", default: "192.168.0.10" },
    "scip-port": { type: "string" },
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
    case "lidar": {
      const l = new LidarSource(args.host!, args["scip-port"] ? Number(args["scip-port"]) : undefined);
      l.onLog = (msg, extra) => log(msg, extra);
      await l.probe();
      return l;
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
  if ("onRestart" in source) source.onRestart = () => {
    log("detector.reset", { detail: "センサーにつなぎ直したので、背景を覚え直します" });
    pipeline.detector.resetBackground();
  };
  const recorder = args.record
    ? new Recorder(args.record, { spec: source.spec, source: source.name, knownHomography: source.knownHomography })
    : null;

  // ---- 壁の画面への操作（壁サーバーから使う） ----
  const roles = new Map<WebSocket, "wall" | "draft">();
  const pending = new Map<number, (r: { ok: boolean; data?: unknown; error?: string }) => void>();
  let reqSeq = 1;
  const wallClient = () => [...roles].find(([ws, r]) => r === "wall" && ws.readyState === WebSocket.OPEN)?.[0];
  const toWall = (a: WallAction, timeoutMs = 5000) =>
    new Promise<{ ok: boolean; data?: unknown; error?: string }>((resolve) => {
      const ws = wallClient();
      if (!ws) return resolve({ ok: false, error: "壁の画面が開いていません（ブラウザで http://127.0.0.1:5173 を開いてください）" });
      const reqId = reqSeq++;
      const timer = setTimeout(() => {
        pending.delete(reqId);
        resolve({ ok: false, error: "壁の画面から返事がありません" });
      }, timeoutMs);
      pending.set(reqId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      ws.send(JSON.stringify({ kind: "control", reqId, ...a } satisfies HubMessage));
    });

  // 調整した値は保存しておき、画面が開き直しても引き継ぐ
  let savedParams: Record<string, Record<string, unknown>> = existsSync(PARAMS_FILE)
    ? (JSON.parse(readFileSync(PARAMS_FILE, "utf8")) as typeof savedParams)
    : {};
  const saveParams = () => {
    mkdirSync("config", { recursive: true });
    writeFileSync(PARAMS_FILE, `${JSON.stringify(savedParams, null, 2)}\n`);
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => resolve(b));
    });

  const http = createServer(async (req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/api/status") {
        const last = pipeline.last;
        return json(200, {
          ok: true,
          source: source.name,
          model: source.spec.model,
          sensor,
          calibration: loadCalibration() ? "file" : source.knownHomography ? "known" : "none",
          wallOpen: Boolean(wallClient()),
          clients: [...roles.values()],
          last10s: lastStats,
          params: savedParams,
          detector: last ? { learning: last.learning, tracks: last.tracks.length, blobs: last.blobs.length } : null,
        });
      }
      if (req.method === "GET" && req.url === "/api/points") {
        // センサー座標（メートル）の今の物体。合わせ込みで使う
        const last = pipeline.last;
        return json(200, { t: last?.t ?? null, learning: last?.learning ?? true, tracks: last?.tracks ?? [], blobs: last?.blobs ?? [] });
      }
      if (req.method === "POST" && req.url === "/api/wall") {
        const a = JSON.parse(await readBody(req)) as WallAction;
        if (a.action === "setParams") {
          savedParams[a.id] = { ...savedParams[a.id], ...a.values };
          saveParams();
          log("params.set", { id: a.id, values: a.values });
        }
        const r = await toWall(a);
        log("wall.action", { action: a.action, ok: r.ok, error: r.error });
        return json(200, r);
      }
      if (req.method === "POST" && req.url === "/api/params/reset") {
        const { id } = JSON.parse(await readBody(req)) as { id: string };
        delete savedParams[id];
        saveParams();
        return json(200, { ok: true });
      }
      json(200, { ok: true, source: source.name, clients: wss.clients.size });
    } catch (e) {
      json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
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
    ws.send(JSON.stringify({ kind: "status", sensor, source: source.name } satisfies HubMessage));
    ws.on("message", (data) => {
      const m = JSON.parse(String(data)) as ClientMessage;
      if (m.kind === "hello") {
        roles.set(ws, m.role);
        log("client.connect", { role: m.role, clients: wss.clients.size });
        // 壁の画面には、保存してある調整値を送る
        if (m.role === "wall")
          for (const [id, values] of Object.entries(savedParams))
            ws.send(JSON.stringify({ kind: "control", reqId: 0, action: "setParams", id, values } satisfies HubMessage));
      } else if (m.kind === "reply") {
        pending.get(m.reqId)?.(m);
        pending.delete(m.reqId);
      }
    });
    ws.on("close", () => roles.delete(ws));
  });

  let frames = 0;
  let downs = 0;
  let lastStats = { frames: 0, downs: 0 };
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
    lastStats = { frames, downs };
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
