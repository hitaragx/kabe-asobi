// 遊びのファイルの管理。
// - web/games/<id>.ts … 下書き。Claude が書く・直す場所
// - web/live/<id>.ts  … 壁に出してよいもの。検証に通った下書きだけがここにコピーされる
// - .history/<id>/    … 壁に出していた前の版。「さっきのに戻して」で戻す

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

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

/** 下書きを壁に出す。前の版は .history に残す */
export function publishFile(id: string): { previousSaved: boolean } {
  checkId(id);
  const d = join(DRAFT_DIR, `${id}.ts`);
  const l = join(LIVE_DIR, `${id}.ts`);
  if (!existsSync(d)) throw new Error(`下書きがありません: ${d}`);
  let previousSaved = false;
  if (existsSync(l)) {
    if (readFileSync(d, "utf8") === readFileSync(l, "utf8")) return { previousSaved: false };
    const dir = join(HISTORY_DIR, id);
    mkdirSync(dir, { recursive: true });
    copyFileSync(l, join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.ts`));
    previousSaved = true;
  }
  mkdirSync(LIVE_DIR, { recursive: true });
  copyFileSync(d, l);
  return { previousSaved };
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
