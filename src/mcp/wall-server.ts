// 壁サーバー（MCP）：Claude が壁の遊びを扱うための道具。
// ハブ（src/server/hub.ts）と壁の画面（ブラウザ）が動いている前提で使う。
//
// 流れ：web/games/<id>.ts を書く → verify_game → publish_game（検証に通れば壁に出る）
//       → 職員の「もっと〇〇して」は set_params か、下書きを直して再び publish_game
//       → 「さっきのに戻して」は rollback_game（同じ遊びの前の版）か previous_game（前の遊び）

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HUB_PORT, type WallAction } from "../shared/protocol.ts";
import { analyze, listRecordings, loadRecording } from "../input/analyze.ts";
import { checkId, listGameFiles, publishFile, rollbackFile } from "../server/games.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.chdir(ROOT);
const HUB = `http://127.0.0.1:${HUB_PORT}`;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (v: unknown): Content => ({ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) });
const result = (...content: Content[]) => ({ content });
const fail = (msg: string) => ({ content: [text(msg)], isError: true });

async function hubGet(path: string): Promise<any> {
  try {
    const r = await fetch(HUB + path);
    return await r.json();
  } catch {
    throw new Error("ハブが動いていません。`npm run dev` で起動してください");
  }
}

async function wall(a: WallAction): Promise<{ ok: boolean; data?: any; error?: string }> {
  try {
    const r = await fetch(`${HUB}/api/wall`, { method: "POST", body: JSON.stringify(a) });
    return (await r.json()) as { ok: boolean; data?: unknown; error?: string };
  } catch {
    return { ok: false, error: "ハブが動いていません。`npm run dev` で起動してください" };
  }
}

/** 壁の画面が（開き直しのあと）つながるまで待つ */
async function waitWall(ms = 8000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await hubGet("/api/status").catch(() => null);
    if (s?.wallOpen) {
      const st = await wall({ action: "stats" });
      if (st.ok) return true;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

interface VerifyResult {
  ok: boolean;
  error?: string;
  results?: { id: string; ok: boolean; fps: number; problems: string[]; screenshots: string[] }[];
}

function runVerify(id: string, seconds: number): Promise<VerifyResult> {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["tsx", "tools/verify.ts", id, "--draft", "--seconds", String(seconds)],
      { cwd: ROOT, timeout: 120000 },
      (_err, stdout) => {
        try {
          resolve(JSON.parse(stdout) as VerifyResult);
        } catch {
          resolve({ ok: false, error: `検証の結果を読めませんでした: ${stdout.slice(0, 500)}` });
        }
      },
    );
  });
}

const image = (path: string): Content => ({ type: "image", data: readFileSync(path).toString("base64"), mimeType: "image/png" });

const server = new McpServer({ name: "kabe-wall", version: "0.1.0" });

server.registerTool(
  "wall_status",
  {
    description: "壁の状態：センサー（ok/lost）、合わせ込みの有無、壁に出ている遊び、FPS、反応の遅れ、エラー、直近10秒の当たりの数。",
  },
  async () => {
    const hub = await hubGet("/api/status");
    const st = await wall({ action: "stats" });
    return result(text({ hub, wall: st.ok ? st.data : { error: st.error } }));
  },
);

server.registerTool(
  "list_games",
  {
    description:
      "遊びの一覧。files：下書き（web/games）と壁の版（web/live）の有無、未公開の変更があるか、戻せる前の版の数。games：壁に出せる遊びの説明と調整できる値。",
  },
  async () => {
    const g = await wall({ action: "games" });
    return result(text({ files: listGameFiles(), games: g.ok ? g.data : { error: g.error } }));
  },
);

server.registerTool(
  "verify_game",
  {
    description:
      "下書き web/games/<id>.ts をヘッドレスブラウザで開き、当たりを流して、エラー・FPS・後片付け漏れを確かめる。遊んでいる途中のスクリーンショットも返すので、子どもに分かりやすい見た目かも確認すること。",
    inputSchema: { id: z.string().describe("遊びのID（ファイル名）"), seconds: z.number().min(2).max(30).optional() },
  },
  async ({ id, seconds }) => {
    checkId(id);
    const r = await runVerify(id, seconds ?? 6);
    const one = r.results?.[0];
    const shots = one?.screenshots.filter((p) => p.endsWith("-play.png") || p.endsWith("-start.png")) ?? [];
    return result(text(r), ...shots.map(image));
  },
);

server.registerTool(
  "publish_game",
  {
    description:
      "下書きを検証し、合格したら壁に出す（web/live にコピーし、壁の画面をその遊びに切り替える）。前の版は自動で保存され、rollback_game で戻せる。不合格なら壁は変えない。",
    inputSchema: { id: z.string(), seconds: z.number().min(2).max(30).optional() },
  },
  async ({ id, seconds }) => {
    checkId(id);
    const r = await runVerify(id, seconds ?? 6);
    if (!r.ok) return { ...result(text({ published: false, reason: "検証に通りませんでした。壁は変えていません", verify: r })), isError: true };
    const { previousSaved } = publishFile(id);
    // 壁の版のファイルが変わると、壁の画面は自動で開き直す。つながったら切り替える
    await new Promise((res) => setTimeout(res, 800));
    const up = await waitWall();
    const shown = up ? await wall({ action: "load", id }) : { ok: false, error: "壁の画面が開いていません" };
    return result(text({ published: true, previousSaved, shown: shown.ok, wall: shown.ok ? shown.data : shown.error }));
  },
);

server.registerTool(
  "rollback_game",
  {
    description: "「さっきのに戻して」：壁に出ている遊びを、ひとつ前の版に戻す（下書きも同じ内容に戻る）。",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    try {
      const r = rollbackFile(id);
      await new Promise((res) => setTimeout(res, 800));
      const shown = (await waitWall()) ? await wall({ action: "load", id }) : { ok: false, error: "壁の画面が開いていません" };
      return result(text({ rolledBack: true, restored: r.restored, shown: shown.ok }));
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  "show_game",
  { description: "壁に出す遊びを切り替える（壁の版にある遊びだけ）。", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const r = await wall({ action: "load", id });
    return r.ok ? result(text(r.data)) : fail(r.error ?? "切り替えられませんでした");
  },
);

server.registerTool(
  "previous_game",
  { description: "壁を、ひとつ前に出していた遊びに戻す。" },
  async () => {
    const r = await wall({ action: "back" });
    return r.ok ? result(text(r.data)) : fail(r.error ?? "戻せませんでした");
  },
);

server.registerTool(
  "set_params",
  {
    description:
      "遊びの調整できる値（params）をその場で変える。「的を大きく」「ゆっくりに」などはまずこれで直す（1秒で反映、コードは変えない）。値は保存され、画面を開き直しても残る。",
    inputSchema: {
      id: z.string(),
      values: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
    },
  },
  async ({ id, values }) => {
    const r = await wall({ action: "setParams", id, values });
    return r.ok ? result(text({ ok: true, values })) : fail(r.error ?? "変えられませんでした");
  },
);

server.registerTool(
  "set_zones",
  {
    description:
      "壁を区画に分けて、区画ごとに的の大きさ・速さを変える（「小さい子の側だけ大きく・ゆっくり」「下の方は車いすの子用に大きく」など）。座標は 0〜1（左上が原点）。区画は壁に点線と名前で表示される。zones を空の配列にすると区画をやめる。値は保存される。",
    inputSchema: {
      id: z.string().describe("遊びのID"),
      zones: z
        .array(
          z.object({
            x0: z.number().min(0).max(1),
            y0: z.number().min(0).max(1),
            x1: z.number().min(0).max(1),
            y1: z.number().min(0).max(1),
            size: z.number().min(0.3).max(3).optional().describe("大きさの倍率"),
            speed: z.number().min(0).max(3).optional().describe("速さの倍率"),
            label: z.string().max(20).optional().describe("壁に出す名前（例：ちいさい子）"),
          }),
        )
        .describe("例：[{x0:0,y0:0,x1:0.5,y1:1,size:1.5,speed:0.6,label:'ちいさい子'},{x0:0.5,y0:0,x1:1,y1:1,label:'おおきい子'}]"),
    },
  },
  async ({ id, zones }) => {
    const r = await wall({ action: "setParams", id, values: { zones } });
    return r.ok ? result(text({ ok: true, zones })) : fail(r.error ?? "設定できませんでした");
  },
);

server.registerTool(
  "reset_params",
  { description: "set_params で変えた値を消して、遊びのファイルに書いてある値に戻す。", inputSchema: { id: z.string() } },
  async ({ id }) => {
    await fetch(`${HUB}/api/params/reset`, { method: "POST", body: JSON.stringify({ id }) });
    await wall({ action: "reload" });
    return result(text({ ok: true }));
  },
);

server.registerTool(
  "wall_screenshot",
  { description: "壁に今映っている画面を撮る（本物の画面。職員に見え方を確認したいとき、反映を確かめたいとき）。" },
  async () => {
    const r = await wall({ action: "snapshot" });
    if (!r.ok || typeof r.data !== "string") return fail(r.error ?? "撮れませんでした");
    const [head, data] = r.data.split(",");
    const mimeType = head?.match(/data:(.*?);/)?.[1] ?? "image/jpeg";
    return result({ type: "image", data: data ?? "", mimeType });
  },
);

server.registerTool(
  "sensor_objects",
  {
    description:
      "センサーが今とらえている物体（センサー座標、メートル）。tracks は追跡中の物体、blobs はこのスキャンで見つかったまとまり。合わせ込みや、反応しないときの原因調べに使う。",
  },
  async () => result(text(await hubGet("/api/points"))),
);

server.registerTool(
  "test_hit",
  {
    description: "壁の画面に、模擬の当たりを起こす（x, y は 0〜1、左上が原点）。反応を確かめるとき用。",
    inputSchema: { x: z.number().min(0).max(1), y: z.number().min(0).max(1) },
  },
  async ({ x, y }) => {
    const r = await wall({ action: "hit", x, y });
    return r.ok ? result(text({ ok: true })) : fail(r.error ?? "起こせませんでした");
  },
);

// ---- 合わせ込み ----

async function hubPost(path: string, body: unknown = {}): Promise<any> {
  try {
    const r = await fetch(HUB + path, { method: "POST", body: JSON.stringify(body) });
    return await r.json();
  } catch {
    throw new Error("ハブが動いていません。`npm run dev` で起動してください");
  }
}

server.registerTool(
  "calibrate_start",
  {
    description:
      "壁への合わせ込みを始める。壁に番号つきの丸が順に光るので、職員に「光った丸を手でタッチして、少し押さえてください」と案内する。4隅のあと、確認用の丸（?）が2つ出る。進み具合は calibrate_status で見る。",
  },
  async () => result(text(await hubPost("/api/calibration/start"))),
);

server.registerTool(
  "calibrate_status",
  {
    description:
      "合わせ込みの進み具合。phase：collect（4隅を記録中）→ check（確認中）→ done（合格・保存済み）/ failed（不合格）。checkErrorsCm が確認用の丸でのずれ（cm、合格は passCm 以下）。failed なら、ずれの大きい丸だけ calibrate_redo でやり直すか、calibrate_start で最初から。",
  },
  async () => result(text(await hubGet("/api/calibration"))),
);

server.registerTool(
  "calibrate_redo",
  {
    description: "合わせ込みの丸を1つだけやり直す（index は0から。4隅は0〜3）。",
    inputSchema: { index: z.number().int().min(0) },
  },
  async ({ index }) => result(text(await hubPost("/api/calibration/redo", { index }))),
);

server.registerTool(
  "calibrate_cancel",
  { description: "合わせ込みをやめて、遊びの画面に戻す（前の合わせ込みの結果のまま）。" },
  async () => result(text(await hubPost("/api/calibration/cancel"))),
);

// ---- センサーの調整（当たり検出） ----

server.registerTool(
  "sensor_tuning",
  {
    description:
      "当たり検出の調整値（いまハブで使っている値）と、それぞれの意味・上げ下げの目安を返す。値を変える前に必ず見る。",
  },
  async () => result(text(await hubGet("/api/detector"))),
);

server.registerTool(
  "sensor_tuning_set",
  {
    description:
      "当たり検出の調整値を変える（ハブを止めずにすぐ効き、config/detector.json に保存される）。変える前に analyze_recording で、記録を流して効果を数字で確かめること。一度に変えるのは1〜2個まで。",
    inputSchema: {
      values: z
        .record(z.string(), z.union([z.number(), z.array(z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }))]))
        .describe("例：{ clusterGap: 0.12, lostMs: 100 }、無視する場所は { ignoreRects: [{x0,y0,x1,y1}] }"),
    },
  },
  async ({ values }) => {
    const r = await hubPost("/api/detector", { values });
    return r.ok ? result(text(r)) : fail(r.error ?? "変えられませんでした");
  },
);

server.registerTool(
  "sensor_relearn",
  {
    description: "何もない状態の距離（背景）を覚え直す。センサーや家具を動かしたあとに使う。職員に「壁の前から1秒だけ離れてください」と伝えてから呼ぶ。",
  },
  async () => result(text(await hubPost("/api/detector/relearn"))),
);

server.registerTool(
  "list_recordings",
  { description: "記録したセンサーのデータ（recordings/*.jsonl）の一覧。" },
  async () => result(text(listRecordings())),
);

server.registerTool(
  "analyze_recording",
  {
    description: `記録を、指定した調整値で流し直して数える（壁や遊びには影響しない）。返す値：
- downs：遊びに届く当たりの数（画面の中）。downsAll はセンサーが拾った全部
- truth：模擬の記録だけ。投げた数・拾えた数・割合（recall）・余計に数えた数（extraDowns）・ずれ（cm）
- quietFalseDowns：背景を覚えたあと quietSec 秒の間（誰もいないはず）の当たり＝誤反応
- suspectedDoubles：150ms 以内・15cm 以内に続いた当たり＝1回を二重に数えた疑い
- durationsMs：当たりの続いた時間の分布（ボールは50〜150ms、手のタッチは数百ms〜）
- widthM：物の幅（ボール約0.07m、手0.05〜0.1m、人の体0.2m〜）
- lingering：3秒以上居座った物（家具・人・カーテンの疑い。ignoreRects の候補）
- hotspots：当たりが集中した場所（センサー座標の升目）
values を省くと、いまの調整値で数える。`,
    inputSchema: {
      file: z.string().describe("recordings/ の下のファイル"),
      values: z.record(z.string(), z.unknown()).optional().describe("試したい調整値（いまの値に上書き）"),
      quietSec: z.number().optional().describe("背景を覚えたあと、誰もいなかった秒数"),
      fromSec: z.number().optional(),
      toSec: z.number().optional(),
    },
  },
  async ({ file, values, quietSec, fromSec, toSec }) => {
    if (!/^recordings\/[\w.-]+\.jsonl$/.test(file)) return fail("recordings/ の下の .jsonl を指定してください");
    const rec = await loadRecording(file);
    const current = (await hubGet("/api/detector").catch(() => null))?.options ?? {};
    let homography = null;
    try {
      homography = JSON.parse(readFileSync("config/calibration.json", "utf8")).homography;
    } catch {
      // 合わせ込みがまだなら、模擬の記録の正解の変換を使う（なければ画面の判定はしない）
    }
    const a = analyze(rec, {
      detector: { ...current, ...(values as object) },
      homography,
      quietMs: quietSec ? quietSec * 1000 : undefined,
      fromSec,
      toSec,
    });
    return result(text(a));
  },
);

await server.connect(new StdioServerTransport());
