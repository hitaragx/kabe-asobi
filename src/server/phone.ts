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
import { HUB_PORT, MUSIC_STYLES } from "../shared/protocol.ts";
import { type Assistant, type AssistantEvent, ClaudeAssistant, MockAssistant, type Plan } from "./assistant.ts";
import { type GameVersion, deleteGame, linkRequest, readMeta } from "./games.ts";
import { isPreset } from "../shared/presets.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.chdir(ROOT);
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

// APIキーと、固定したい合言葉は .env から読み、このプロセスの中だけで使う
const envFile = join(ROOT, ".env");
let apiKey = "";
let fixedKey = "";
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*(ANTHROPIC_API_KEY|KABE_PHONE_KEY)\s*=\s*"?([^"\s]+)"?\s*$/);
    if (m?.[1] === "ANTHROPIC_API_KEY") apiKey = m[2]!;
    if (m?.[1] === "KABE_PHONE_KEY") fixedKey = m[2]!;
  }
}
const assistant: Assistant =
  !args.mock && apiKey ? new ClaudeAssistant(ROOT, apiKey, { model: args.model }) : new MockAssistant();

// 合言葉：起動オプション → .env の KABE_PHONE_KEY → 起動のたびに変わる乱数。
// .env で固定しておくと、職員は最初の一度だけ URL をスマホに保存すればよい
const KEY = args.key ?? (fixedKey || randomBytes(4).toString("hex"));

// ---- 会話の記録（画面を開き直しても続きが見えるように。ファイルは logs/ に、リポジトリには入れない） ----
type Turn = { role: "staff" | "claude"; text: string; steps?: string[]; plan?: Plan; at: number; seconds?: number; costUsd?: number; error?: string };
const history: Turn[] = [];
mkdirSync(join(ROOT, "logs"), { recursive: true });
const logFile = join(ROOT, "logs", `phone-${new Date().toISOString().slice(0, 10)}.jsonl`);
const record = (t: Turn) => appendFileSync(logFile, `${JSON.stringify(t)}\n`);

// ---- 頼みごとの記録（スマホの「きろく」に出す。起動し直しても残る。logs/ はリポジトリに入れない） ----
type RequestRecord = {
  at: number;
  request: string;
  reply: string;
  seconds?: number;
  costUsd?: number;
  ok: boolean;
  assistant: "claude" | "mock";
  /** この頼みごとで作った・直した遊び */
  games: { id: string; kind: GameVersion["kind"] }[];
  /** 頼みごとが終わったとき壁に出ていた遊び（値の調整など、版が変わらない頼みごとも遊びごとに見られるように） */
  shown?: string | null;
};
const requestsFile = join(ROOT, "logs", "requests.jsonl");
const requests: RequestRecord[] = existsSync(requestsFile)
  ? readFileSync(requestsFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as RequestRecord];
        } catch {
          return [];
        }
      })
  : [];

let busy: AbortController | null = null;

/**
 * 職員の返事を待っている案。「これで作って」を押すと作り始める。
 * request は、きろくに残す元の頼みごと（案を直してもらった言葉も足していく）
 */
let pendingPlan: { plan: Plan; request: string } | null = null;

/** この言葉が出たら、遊びを書き始めた（壁に「つくってるよ」を出す） */
const BUILD_STEPS = new Set(["遊びを書いています", "遊びを確かめています", "子どもの目線で確かめています"]);
const making = (state: "start" | "done" | "off") => hub("/api/wall", { action: "making", state });

// ---- 裏側の画面（動画用）：Claude が何をしているかを、見ている画面すべてに配る ----
type Run = { id: number; prompt: string; startedAt: number; seconds?: number; costUsd?: number; turns?: number; ok?: boolean; events: AssistantEvent[] };
const runs: Run[] = [];
const watchers = new Set<ServerResponse>();
const broadcast = (m: unknown) => {
  const line = `data: ${JSON.stringify(m)}\n\n`;
  for (const w of watchers) w.write(line);
};

// ---- 遊びの一覧に、作った日・頼みごと・理由をつける。新しく作った・直した順に並べる ----
function withMeta(games: { id: string; title: string; ages: string; rule: string; music?: string }[]) {
  const meta = readMeta();
  return games
    .map(({ id, title, ages, rule, music }) => {
      const m = meta[id];
      return { id, title, ages, rule, music, preset: isPreset(id), createdAt: m?.createdAt ?? null, updatedAt: m?.updatedAt ?? null, versions: m ? [...m.versions].reverse() : [] };
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.title.localeCompare(b.title, "ja"));
}

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
        pendingPlan: pendingPlan?.plan.id ?? null,
        sensor: status.ok ? status.sensor : "unknown",
        wallOpen: Boolean(status.wallOpen),
        calibration: status.calibration ?? "none",
        audio: status.ok ? status.audio : null,
        musicStyles: MUSIC_STYLES,
        game: stats.ok ? stats.data.game : null,
        games: games.ok ? withMeta(games.data as { id: string; title: string; ages: string; rule: string; music?: string }[]) : [],
        error: status.ok ? undefined : status.error,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/history") return json(res, 200, history);
    if (req.method === "GET" && url.pathname === "/api/requests")
      return json(res, 200, requests.filter((r) => r.assistant === assistant.kind).slice(-100).reverse());
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
      if (a.action === "audio") {
        const { music, sfx, style, id } = a as { music?: number; sfx?: number; style?: string | null; id?: string };
        return json(res, 200, await hub("/api/wall", { action: "audio", music, sfx, styles: id && style !== undefined ? { [id]: style } : undefined }));
      }
      if (a.action === "delete" && a.id) {
        // 職員が作った遊びだけ消せる（ファイルは .trash に移すので、間違えても戻せる）
        if (isPreset(a.id)) return json(res, 200, { ok: false, error: "はじめから入っている遊びは消せません" });
        if (busy) return json(res, 200, { ok: false, error: "いま Claude が作業中です。終わってから消してください" });
        // 壁に出ている遊びなら、先に別の遊びに切り替える
        const stats = await hub("/api/wall", { action: "stats" });
        if (stats.ok && stats.data.game === a.id) await hub("/api/wall", { action: "load", id: "balloons" });
        try {
          const r = deleteGame(a.id);
          console.log(`遊びを消しました：${a.id}（${r.movedTo.replaceAll("\\", "/")} に移しました）`);
          return json(res, 200, { ok: true });
        } catch (e) {
          return json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
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
      pendingPlan = null;
      return json(res, 200, { ok: true });
    }

    // ---- 話しかける（返事は少しずつ送る：Server-Sent Events） ----
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const { text, approve } = JSON.parse((await readBody(req)) || "{}") as { text?: string; approve?: string };
      if (!text?.trim()) return json(res, 400, { error: "空です" });
      if (approve && approve !== pendingPlan?.plan.id) return json(res, 409, { error: "この案は、もう古くなっています。もう一度頼んでください" });
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
      const prev = pendingPlan;
      pendingPlan = null;
      // 案を直してもらう言葉なら、元の頼みごとに足す（関係ない調整なら、その言葉だけ）
      const revised = prev ? `${prev.request}／${staff.text}` : staff.text;
      let built = Boolean(approve);
      let planned = false;
      if (built) void making("start");
      // Claude への言葉。承認のときは、どの案かを添える
      const prompt = approve && prev ? `この案で作ってください：「${prev.plan.title}」` : staff.text;
      await assistant.send(prompt, (e) => {
        if (e.type === "step") {
          reply.steps!.push(e.text);
          if (!built && BUILD_STEPS.has(e.text)) {
            built = true;
            void making("start");
          }
        }
        if (e.type === "plan") {
          reply.plan = e.plan;
          pendingPlan = { plan: e.plan, request: approve && prev ? prev.request : revised };
          planned = true;
        }
        if (e.type === "text") reply.text += e.delta;
        if (e.type === "done") {
          reply.text = e.text || reply.text;
          reply.seconds = e.seconds;
          reply.costUsd = e.costUsd;
        }
        if (e.type === "error") {
          reply.error = e.message;
          if (e.costUsd !== undefined) reply.costUsd = e.costUsd;
        }
        if (e.type !== "text") run.events.push(e);
        if (e.type === "done") Object.assign(run, { seconds: e.seconds, costUsd: e.costUsd, turns: e.turns, ok: true });
        if (e.type === "error") Object.assign(run, { ok: false, costUsd: e.costUsd ?? run.costUsd });
        broadcast({ kind: "event", runId: run.id, event: e });
        send(e);
      }, ac.signal);
      history.push(reply);
      record(reply);
      // 作るのを止めた・失敗したときは、同じ案でもう一度「これで作って」を押せるように残す
      if (reply.error && approve && prev && !pendingPlan) pendingPlan = prev;
      // この頼みごとの間に壁に出た遊びに、頼みごとを結びつける
      const madeNew = Object.values(readMeta()).some((g) => g.versions.some((v) => v.at >= run.startedAt && v.kind === "new"));
      const request = approve && prev ? prev.request : prev && (planned || madeNew) ? revised : staff.text;
      const touched = linkRequest(run.startedAt, request);
      if (built) void making(touched.some((g) => g.kind !== "rollback") && !reply.error ? "done" : "off");
      busy = null;
      res.end();
      // 案を見せただけのときは、きろくに残さない（「これで作って」を押したときに、元の頼みごとで残す）
      if (planned && touched.length === 0) return;
      const after = await hub("/api/wall", { action: "stats" });
      const rec: RequestRecord = {
        shown: after.ok ? ((after.data as { game?: string | null }).game ?? null) : null,
        at: run.startedAt,
        request,
        reply: reply.error ? `うまくいきませんでした（${reply.error}）` : reply.text,
        seconds: reply.seconds,
        costUsd: reply.costUsd,
        ok: !reply.error,
        assistant: assistant.kind,
        games: touched,
      };
      requests.push(rec);
      appendFileSync(requestsFile, `${JSON.stringify(rec)}\n`);
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    busy = null;
    if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    else res.end();
  }
});

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`ポート ${args.port} はもう使われています。前のスマホ画面のサーバーが動いたままではありませんか。止めてから、もう一度起動してください`);
    process.exit(1);
  }
  throw e;
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
