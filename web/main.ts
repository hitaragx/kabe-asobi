// 入口：画面を作り、遊びを読み込む。
// URL の ?game=<id> で遊びを選ぶ。?debug=1 で当たり位置と FPS を表示する。

import { Application, Graphics, Text } from "pixi.js";
import type { GameDefinition } from "./engine/game.ts";
import { CalibrationView } from "./engine/calibration-view.ts";
import { WallInput } from "./engine/input.ts";
import { Runtime } from "./engine/runtime.ts";
import { unlockAudio } from "./engine/sound.ts";
import { palette } from "./engine/style.ts";

const params = new URLSearchParams(location.search);
const debug = params.has("debug");

const app = new Application();
await app.init({ resizeTo: window, background: palette.bg, antialias: true });
document.body.appendChild(app.canvas);

// ?draft なら下書き（web/games）を、そうでなければ壁に出してよいもの（web/live）を読み込む
const draft = params.has("draft");
const input = new WallInput(() => ({ width: app.screen.width, height: app.screen.height }), app.canvas, draft ? "draft" : "wall");
const runtime = new Runtime(app, input, {
  attractAfterMs: Number(params.get("attract") ?? 30000),
  resetAfterMs: Number(params.get("reset") ?? 180000),
});

// 遊びを読み込む。1つ壊れていても、ほかの遊びは動くように1つずつ読み込む
const loaders = draft
  ? import.meta.glob<{ default: GameDefinition }>("./games/*.ts")
  : import.meta.glob<{ default: GameDefinition }>("./live/*.ts");
const loadErrors: { file: string; message: string }[] = [];
await Promise.all(
  Object.entries(loaders).map(async ([file, load]) => {
    try {
      runtime.register((await load()).default);
    } catch (e) {
      loadErrors.push({ file, message: e instanceof Error ? e.message : String(e) });
      console.error(`[kabe] 読み込めません ${file}`, e);
    }
  }),
);

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
const pct = (v: number[], q: number) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
};
/** 遅れの内訳（p50 と p95、ミリ秒） */
const latency = () => {
  const xs = input.latencySamples;
  const part = (k: "hub" | "net" | "frame" | "total") => ({ p50: pct(xs.map((x) => x[k]), 0.5), p95: pct(xs.map((x) => x[k]), 0.95) });
  return { n: xs.length, hub: part("hub"), net: part("net"), frame: part("frame"), total: part("total") };
};
const stats = () => ({
  game: runtime.current?.def.id ?? null,
  mode: draft ? "draft" : "wall",
  fps: Math.round(fps()),
  sensor: input.status,
  errors: runtime.errors,
  loadErrors,
  history: runtime.history,
  objects: app.stage.children.reduce((n, c) => n + 1 + c.children.length, 0),
  fxObjects: runtime.fxLayer.children.length,
  latencyMs: input.latencies.length ? [...input.latencies].sort((a, b) => a - b)[Math.floor(input.latencies.length / 2)] : null,
  latency: latency(),
  size: { width: app.screen.width, height: app.screen.height },
});
const games = () =>
  [...runtime.games.values()].map((g) => ({
    id: g.id,
    title: g.title,
    rule: g.rule,
    ages: g.ages,
    input: g.input,
    description: g.description,
    params: Object.fromEntries(Object.entries(g.params).map(([k, p]) => [k, { label: p.label, value: p.value, min: p.min, max: p.max }])),
  }));

const calibView = new CalibrationView(app, [runtime.gameLayer, runtime.zoneLayer, runtime.fxLayer, runtime.uiLayer]);

input.controlHandler = async (a) => {
  switch (a.action) {
    case "load":
      if (!runtime.load(a.id)) throw new Error(`遊びを出せませんでした: ${a.id}`);
      return stats();
    case "back":
      if (!runtime.back()) throw new Error("戻せる遊びがありません");
      return stats();
    case "setParams":
      runtime.setParams(a.id, a.values);
      return stats();
    case "stats":
      return stats();
    case "games":
      return games();
    case "hit":
      input.inject(a.x, a.y, "inject");
      return true;
    case "snapshot":
      // 壁に映っている画面そのものを、軽いJPEGで返す
      return await app.renderer.extract.base64({ target: app.stage, frame: app.screen.clone(), resolution: 0.5, format: "jpg", quality: 0.8 });
    case "calibration":
      calibView.set(a.view);
      return true;
    case "reload":
      setTimeout(() => location.reload(), 50);
      return true;
  }
};

window.__kabe = {
  games,
  load: (id: string) => runtime.load(id),
  back: () => runtime.back(),
  setParams: (id: string, v: Record<string, unknown>) => runtime.setParams(id, v),
  /** 正規化座標で当たりを起こす */
  hit: (x: number, y: number) => input.inject(x, y),
  stats,
};
