// 遊びのファイルの管理。
// - web/games/<id>.ts … 下書き。Claude が書く・直す場所
// - web/live/<id>.ts  … 壁に出してよいもの。検証に通った下書きだけがここにコピーされる
// - .history/<id>/    … 壁に出していた前の版。「さっきのに戻して」で戻す
// - config/games-meta.json … いつ作ったか・どの頼みごとから・なぜこの遊びにしたか（施設のデータなのでリポジトリに入れない）

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DRAFT_DIR = "web/games";
export const LIVE_DIR = "web/live";
export const HISTORY_DIR = ".history";

export function checkId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`遊びのIDは英小文字・数字・ハイフンで書いてください: ${id}`);
}

const ids = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => f.slice(0, -3))
    : [];

const historyOf = (id: string) => {
  const dir = join(HISTORY_DIR, id);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ts")).sort() : [];
};

export interface GameFileState {
  id: string;
  draft: boolean;
  live: boolean;
  /** 下書きが壁の版と違う（まだ壁に出していない変更がある） */
  changed: boolean;
  /** 戻せる前の版の数 */
  history: number;
}

export function listGameFiles(): GameFileState[] {
  const all = new Set([...ids(DRAFT_DIR), ...ids(LIVE_DIR)]);
  return [...all].sort().map((id) => {
    const d = join(DRAFT_DIR, `${id}.ts`);
    const l = join(LIVE_DIR, `${id}.ts`);
    const draft = existsSync(d);
    const live = existsSync(l);
    const changed = draft && (!live || readFileSync(d, "utf8") !== readFileSync(l, "utf8"));
    return { id, draft, live, changed, history: historyOf(id).length };
  });
}

/** 壁に出した版ごとの記録 */
export interface GameVersion {
  at: number;
  kind: "new" | "update" | "rollback";
  /** 職員の頼みごと（スマホのサーバーが、その頼みごとの作業中に出た版に結びつける） */
  request?: string;
  /** Claude が書いた「なぜこの頼みごとから、この遊び・この直し方にしたか」 */
  reason?: string;
}
export interface GameMeta {
  createdAt: number;
  updatedAt: number;
  versions: GameVersion[];
}

export const metaFile = () => process.env.KABE_GAMES_META ?? join("config", "games-meta.json");

export function readMeta(): Record<string, GameMeta> {
  try {
    return JSON.parse(readFileSync(metaFile(), "utf8")) as Record<string, GameMeta>;
  } catch {
    return {};
  }
}
function writeMeta(m: Record<string, GameMeta>): void {
  mkdirSync(dirname(metaFile()), { recursive: true });
  writeFileSync(metaFile(), `${JSON.stringify(m, null, 2)}\n`);
}

/** 壁に出した・戻したことを記録する */
export function noteVersion(id: string, v: Omit<GameVersion, "at">): void {
  const m = readMeta();
  const at = Date.now();
  const g = (m[id] ??= { createdAt: at, updatedAt: at, versions: [] });
  g.updatedAt = at;
  g.versions.push({ at, ...v });
  if (g.versions.length > 50) g.versions.splice(0, g.versions.length - 50);
  writeMeta(m);
}

/** since 以降に出た版で、まだ頼みごとが結びついていないものに request を結びつける。結びつけた遊びの ID を返す */
export function linkRequest(since: number, request: string): { id: string; kind: GameVersion["kind"] }[] {
  const m = readMeta();
  const out: { id: string; kind: GameVersion["kind"] }[] = [];
  for (const [id, g] of Object.entries(m)) {
    for (const v of g.versions) {
      if (v.at >= since && v.request === undefined) {
        v.request = request;
        if (!out.some((o) => o.id === id)) out.push({ id, kind: v.kind });
      }
    }
  }
  if (out.length) writeMeta(m);
  return out;
}

/** 下書きを壁に出す。前の版は .history に残す。changed は壁の版が変わったか */
export function publishFile(id: string): { previousSaved: boolean; changed: boolean; isNew: boolean } {
  checkId(id);
  const d = join(DRAFT_DIR, `${id}.ts`);
  const l = join(LIVE_DIR, `${id}.ts`);
  if (!existsSync(d)) throw new Error(`下書きがありません: ${d}`);
  let previousSaved = false;
  if (existsSync(l)) {
    if (readFileSync(d, "utf8") === readFileSync(l, "utf8")) return { previousSaved: false, changed: false, isNew: false };
    const dir = join(HISTORY_DIR, id);
    mkdirSync(dir, { recursive: true });
    copyFileSync(l, join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.ts`));
    previousSaved = true;
  }
  const isNew = !existsSync(l);
  mkdirSync(LIVE_DIR, { recursive: true });
  copyFileSync(d, l);
  return { previousSaved, changed: true, isNew };
}

/** 壁の版を一つ前に戻す。下書きも同じ内容にそろえる */
export function rollbackFile(id: string): { restored: string } {
  checkId(id);
  const h = historyOf(id);
  const last = h.at(-1);
  if (!last) throw new Error(`戻せる前の版がありません: ${id}`);
  const src = join(HISTORY_DIR, id, last);
  copyFileSync(src, join(LIVE_DIR, `${id}.ts`));
  copyFileSync(src, join(DRAFT_DIR, `${id}.ts`));
  unlinkSync(src);
  return { restored: last };
}
