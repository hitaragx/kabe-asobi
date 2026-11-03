// 入口：画面を作り、遊びを読み込む。
// URL の ?game=<id> で遊びを選ぶ。?debug=1 で当たり位置と FPS を表示する。

import { Application, Graphics, Text } from "pixi.js";
import type { GameDefinition } from "./engine/game.ts";
import { WallInput } from "./engine/input.ts";
import { Runtime } from "./engine/runtime.ts";
import { unlockAudio } from "./engine/sound.ts";
import { palette } from "./engine/style.ts";

const params = new URLSearchParams(location.search);
const debug = params.has("debug");

const app = new Application();
await app.init({ resizeTo: window, background: palette.bg, antialias: true });
document.body.appendChild(app.canvas);

const input = new WallInput(() => ({ width: app.screen.width, height: app.screen.height }), app.canvas);
const runtime = new Runtime(app, input, {
  attractAfterMs: Number(params.get("attract") ?? 30000),
  resetAfterMs: Number(params.get("reset") ?? 180000),
});

// web/games/*.ts をすべて読み込む
const modules = import.meta.glob<{ default: GameDefinition }>("./games/*.ts", { eager: true });
for (const m of Object.values(modules)) runtime.register(m.default);

const first = params.get("game") ?? localStorage.getItem("kabe.game") ?? [...runtime.games.keys()][0];
if (first) runtime.load(runtime.games.has(first) ? first : [...runtime.games.keys()][0]!);

// 音の有効化（ブラウザは最初の操作が必要。展示では --autoplay-policy=no-user-gesture-required で起動する）
const unlock = document.getElementById("unlock");
const doUnlock = () => {
  unlockAudio();
  unlock?.remove();
};
if (params.has("muted") || navigator.userActivation?.hasBeenActive) unlock?.remove();
unlock?.addEventListener("pointerdown", doUnlock);
window.addEventListener("pointerdown", doUnlock, { once: true });
window.addEventListener("keydown", doUnlock, { once: true });

// 開発用：数字キーで遊びを切り替え、Backspace で前に戻す
window.addEventListener("keydown", (e) => {
  const ids = [...runtime.games.keys()];
  const n = Number(e.key);
  if (n >= 1 && n <= ids.length) runtime.load(ids[n - 1]!);
  if (e.key === "Backspace") runtime.back();
});

// FPS の計測
const frameTimes: number[] = [];
app.ticker.add((t) => {
  frameTimes.push(t.deltaMS);
  if (frameTimes.length > 120) frameTimes.shift();
});
const fps = () => {
  const avg = frameTimes.reduce((a, b) => a + b, 0) / (frameTimes.length || 1);
  return avg > 0 ? 1000 / avg : 0;
};

if (debug) {
  const g = new Graphics();
  const t = new Text({ text: "", style: { fill: 0xffffff, fontSize: 14, fontFamily: "monospace" } });
  t.x = 8;
  t.y = 8;
  app.stage.addChild(g, t);
  input.onDown((h) => {
    const ring = new Graphics().circle(h.x, h.y, 24).stroke({ width: 3, color: 0xff00ff });
    app.stage.addChild(ring);
    setTimeout(() => ring.destroy(), 400);
  });
  app.ticker.add(() => {
    g.clear();
    for (const p of input.points) g.circle(p.px, p.py, 10).fill({ color: 0x00ffff, alpha: 0.8 });
    const lat = input.latencies;
    const p50 = lat.length ? [...lat].sort((a, b) => a - b)[Math.floor(lat.length / 2)] : "-";
    t.text = `${runtime.current?.def.id ?? "-"}  fps ${fps().toFixed(0)}  sensor ${input.status}  latency p50 ${p50}ms  errors ${runtime.errors.length}`;
  });
}

// 自動検証・壁サーバーから操作するための窓口
declare global {
  interface Window {
    __kabe: unknown;
  }
}
window.__kabe = {
  games: () =>
    [...runtime.games.values()].map((g) => ({ id: g.id, title: g.title, rule: g.rule, ages: g.ages, input: g.input, description: g.description })),
  load: (id: string) => runtime.load(id),
  back: () => runtime.back(),
  setParams: (id: string, v: Record<string, unknown>) => runtime.setParams(id, v),
  /** 正規化座標で当たりを起こす */
  hit: (x: number, y: number) => input.inject(x, y),
  stats: () => ({
    game: runtime.current?.def.id ?? null,
    fps: Math.round(fps()),
    sensor: input.status,
    errors: runtime.errors,
    history: runtime.history,
    objects: app.stage.children.reduce((n, c) => n + 1 + c.children.length, 0),
  }),
};
