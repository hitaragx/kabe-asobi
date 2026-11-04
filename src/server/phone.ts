// スマホ用の画面のサーバー。職員はここから話しかけ、壁の様子を見て、ボタンで操作する。
//
//   npx tsx src/server/phone.ts            （.env に ANTHROPIC_API_KEY があれば本物の Claude、なければ仮の相手）
//   npx tsx src/server/phone.ts --mock     （仮の相手に固定）
//
// 同じ Wi-Fi の中のスマホから開く。起動のたびに合言葉（URL の k=）が変わり、知らない人は使えない。

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HUB_PORT } from "../shared/protocol.ts";
import { type Assistant, type AssistantEvent, ClaudeAssistant, MockAssistant } from "./assistant.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATIC = join(ROOT, "web", "phone");
const HUB = `http://127.0.0.1:${HUB_PORT}`;

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "8790" },
    mock: { type: "boolean", default: false },
    model: { type: "string" },
    /** 合言葉を固定する（撮影のとき用）。省くと起動のたびに変わる */
    key: { type: "string" },
  },
});

// APIキーは .env から読み、このプロセスの中だけで使う
const envFile = join(ROOT, ".env");
let apiKey = "";
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*"?([^"\s]+)"?\s*$/);
    if (m) apiKey = m[1]!;
  }
}
const assistant: Assistant =
  !args.mock && apiKey ? new ClaudeAssistant(ROOT, apiKey, { model: args.model }) : new MockAssistant();

const KEY = args.key ?? randomBytes(4).toString("hex");

// ---- 会話の記録（画面を開き直しても続きが見えるように。ファイルは logs/ に、リポジトリには入れない） ----
type Turn = { role: "staff" | "claude"; text: string; steps?: string[]; at: number; seconds?: number; costUsd?: number; error?: string };
const history: Turn[] = [];
mkdirSync(join(ROOT, "logs"), { recursive: true });
const logFile = join(ROOT, "logs", `phone-${new Date().toISOString().slice(0, 10)}.jsonl`);
const record = (t: Turn) => appendFileSync(logFile, `${JSON.stringify(t)}\n`);

let busy: AbortController | null = null;

// ---- 裏側の画面（動画用）：Claude が何をしているかを、見ている画面すべてに配る ----
type Run = { id: number; prompt: string; startedAt: number; seconds?: number; costUsd?: number; turns?: number; ok?: boolean; events: AssistantEvent[] };
const runs: Run[] = [];
const watchers = new Set<ServerResponse>();
const broadcast = (m: unknown) => {
  const line = `data: ${JSON.stringify(m)}\n\n`;
  for (const w of watchers) w.write(line);
};

// ---- 小道具 ----
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
async function hub(path: string, body?: unknown): Promise<any> {
  try {
    const r = await fetch(HUB + path, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
    return await r.json();
  } catch {
    return { ok: false, error: "壁のしくみ（ハブ）が動いていません" };
  }
}
const authed = (req: IncomingMessage, url: URL) =>
  url.searchParams.get("k") === KEY || (req.headers.cookie ?? "").split(/;\s*/).includes(`kabe_k=${KEY}`);

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (!authed(req, url)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("この画面を開くには、Mac に表示された URL（合言葉つき）を使ってください。");
    return;
  }
  try {
    // ---- 画面 ----
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = normalize(join(STATIC, rel));
      if (!file.startsWith(STATIC) || !existsSync(file)) return json(res, 404, { error: "not found" });
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
        // 合言葉をクッキーに入れ、以後は URL に付けなくてよいようにする
        "set-cookie": `kabe_k=${KEY}; Path=/; SameSite=Strict; Max-Age=86400`,
      });
      res.end(readFileSync(file));
      return;
    }

    // ---- 状態 ----
    if (req.method === "GET" && url.pathname === "/api/state") {
      const [status, stats, games] = await Promise.all([hub("/api/status"), hub("/api/wall", { action: "stats" }), hub("/api/wall", { action: "games" })]);
      return json(res, 200, {
        assistant: assistant.kind,
        busy: busy !== null,
        sensor: status.ok ? status.sensor : "unknown",
        wallOpen: Boolean(status.wallOpen),
        calibration: status.calibration ?? "none",
        game: stats.ok ? stats.data.game : null,
        games: games.ok ? (games.data as { id: string; title: string; ages: string; rule: string }[]).map(({ id, title, ages, rule }) => ({ id, title, ages, rule })).sort((a, b) => a.title.localeCompare(b.title, "ja")) : [],
        error: status.ok ? undefined : status.error,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/history") return json(res, 200, history);
    if (req.method === "GET" && url.pathname === "/api/backstage/state")
      return json(res, 200, { assistant: assistant.kind, busy: busy !== null, runs: runs.slice(-20) });
    if (req.method === "GET" && url.pathname === "/api/backstage/stream") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": hello\n\n");
      watchers.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        watchers.delete(res);
      });
      return;
    }

    // ---- 壁の今の画面（縮小した JPEG） ----
    if (req.method === "GET" && url.pathname === "/api/snapshot") {
      const r = await hub("/api/wall", { action: "snapshot" });
      if (!r.ok || typeof r.data !== "string") return json(res, 503, { error: r.error ?? "撮れませんでした" });
      const [head, data] = (r.data as string).split(",");
      res.writeHead(200, { "content-type": head?.match(/data:(.*?);/)?.[1] ?? "image/jpeg", "cache-control": "no-store" });
      res.end(Buffer.from(data ?? "", "base64"));
      return;
    }

    // ---- ボタン ----
    if (req.method === "POST" && url.pathname === "/api/action") {
      const a = JSON.parse((await readBody(req)) || "{}") as { action: string; id?: string };
      if (a.action === "back") return json(res, 200, await hub("/api/wall", { action: "back" }));
      if (a.action === "load" && a.id) return json(res, 200, await hub("/api/wall", { action: "load", id: a.id }));
      if (a.action === "calibrate") return json(res, 200, await hub("/api/calibration/start", {}));
      if (a.action === "calibrate-status") return json(res, 200, await hub("/api/calibration"));
      if (a.action === "calibrate-cancel") return json(res, 200, await hub("/api/calibration/cancel", {}));
      return json(res, 400, { error: `知らない操作です: ${a.action}` });
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      busy?.abort();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/reset") {
      if (busy) return json(res, 409, { error: "いま作業中です" });
      assistant.reset();
      history.length = 0;
      return json(res, 200, { ok: true });
    }

    // ---- 話しかける（返事は少しずつ送る：Server-Sent Events） ----
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const { text } = JSON.parse((await readBody(req)) || "{}") as { text?: string };
      if (!text?.trim()) return json(res, 400, { error: "空です" });
      if (busy) return json(res, 409, { error: "いま作業中です。終わるまで待ってください" });
      const ac = new AbortController();
      busy = ac;
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
      // 職員の画面には、裏側の記録（trace）は送らない
      const send = (e: AssistantEvent) => e.type !== "trace" && res.write(`data: ${JSON.stringify(e)}\n\n`);
      const run: Run = { id: runs.length + 1, prompt: text.trim(), startedAt: Date.now(), events: [] };
      runs.push(run);
      broadcast({ kind: "start", run: { id: run.id, prompt: run.prompt, startedAt: run.startedAt } });
      const staff: Turn = { role: "staff", text: text.trim(), at: Date.now() };
      history.push(staff);
      record(staff);
      const reply: Turn = { role: "claude", text: "", steps: [], at: Date.now() };
      await assistant.send(staff.text, (e) => {
        if (e.type === "step") reply.steps!.push(e.text);
        if (e.type === "text") reply.text += e.delta;
        if (e.type === "done") {
          reply.text = e.text || reply.text;
          reply.seconds = e.seconds;
          reply.costUsd = e.costUsd;
        }
        if (e.type === "error") reply.error = e.message;
        if (e.type !== "text") run.events.push(e);
        if (e.type === "done") Object.assign(run, { seconds: e.seconds, costUsd: e.costUsd, turns: e.turns, ok: true });
        if (e.type === "error") run.ok = false;
        broadcast({ kind: "event", runId: run.id, event: e });
        send(e);
      }, ac.signal);
      history.push(reply);
      record(reply);
      busy = null;
      res.end();
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    busy = null;
    if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    else res.end();
  }
});

server.listen(Number(args.port), "0.0.0.0", () => {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
  console.log(`スマホの画面（${assistant.kind === "claude" ? "本物の Claude" : "仮の相手"}）`);
  console.log(`  この Mac から：http://127.0.0.1:${args.port}/?k=${KEY}`);
  for (const ip of ips) console.log(`  同じ Wi-Fi のスマホから：http://${ip}:${args.port}/?k=${KEY}`);
  console.log(`裏側の画面（動画用）：http://127.0.0.1:${args.port}/backstage.html?k=${KEY}`);
});
