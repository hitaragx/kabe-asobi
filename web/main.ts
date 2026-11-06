// 入口：画面を作り、遊びを読み込む。
// URL の ?game=<id> で遊びを選ぶ。?debug=1 で当たり位置と FPS を表示する。

import { Application, Graphics, Text } from "pixi.js";
import type { GameDefinition } from "./engine/game.ts";
import { CalibrationView } from "./engine/calibration-view.ts";
import { WallInput } from "./engine/input.ts";
import { MakingBadge } from "./engine/making-badge.ts";
import { Runtime } from "./engine/runtime.ts";
import { type MusicStyle, music } from "./engine/music.ts";
import { onAudioUnlock, recordWav, setMusicVolume, setVolume, sound, unlockAudio, volumes } from "./engine/sound.ts";
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

// 遊びを読み込む。1つ壊れていても、ほかの遊びは動くように1つずつ読み込む。
// 下書きと本番で読み込みのモジュールを分けてあるのは、下書きの保存で壁が読み込み直されないようにするため（draft-games.ts）
const { loaders } = draft ? await import("./draft-games.ts") : await import("./live-games.ts");
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

// 音の有効化。ブラウザは最初の操作が必要なことがあるので、まず試してみて、音が出せるようになったら覆いを消す。
// 展示では --autoplay-policy=no-user-gesture-required で起動すれば（docs/manual.md）、操作なしでそのまま音が出る。
// 壁の画面は publish_game のたびに読み込み直されるので、ここで試さないと、そのたびに覆いが戻って無音になる
const unlock = document.getElementById("unlock");
onAudioUnlock(() => unlock?.remove());
if (params.has("muted")) unlock?.remove();
else unlockAudio();
unlock?.addEventListener("pointerdown", unlockAudio);
window.addEventListener("pointerdown", unlockAudio, { once: true });
window.addEventListener("keydown", unlockAudio, { once: true });

// 開発用（?debug か ?draft のとき）：数字キーで遊びを切り替え、Backspace で前に戻す。
// 壁に映しているときは効かないようにしてある（撮影中にキーボードに触れて遊びが変わらないように）
if (debug || draft)
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
const audioState = () => {
  const v = volumes();
  return { music: Math.round(v.music * 10), sfx: Math.round(v.sfx * 10), playing: music.current || null };
};
const stats = () => ({
  game: runtime.current?.def.id ?? null,
  loadedAt: runtime.loadedAt,
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
  audio: audioState(),
  making: making.current,
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
    music: runtime.musicStyleOf(g.id),
    // value は「いまの値」（set_params で変えたあとの値）。default は遊びに書いてある元の値
    params: Object.fromEntries(
      Object.entries(g.params).map(([k, p]) => [k, { label: p.label, value: runtime.paramsOf(g.id)[k] ?? p.value, default: p.value, min: p.min, max: p.max }]),
    ),
  }));

const calibView = new CalibrationView(app, [runtime.gameLayer, runtime.zoneLayer, runtime.fxLayer, runtime.uiLayer]);
const making = new MakingBadge(app);

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
    case "making":
      making.set(a.state);
      return true;
    case "reload":
      setTimeout(() => location.reload(), 50);
      return true;
    case "audio":
      // ハブは保存してある設定をまとめて送ってくる
      if (a.music !== undefined) setMusicVolume(a.music / 10);
      if (a.sfx !== undefined) setVolume(a.sfx / 10);
      if (a.styles) runtime.setMusicStyles(Object.fromEntries(Object.entries(a.styles).filter(([, v]) => v)) as Record<string, MusicStyle>);
      return audioState();
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
  /** 確認用（?debug のときだけ）：効果音を直接鳴らす */
  sfx: debug ? sound : undefined,
  /** 確認用（?debug のときだけ）：音を録って base64 の WAV で返す */
  recordAudio: debug
    ? async (ms: number) => {
        const b = new Uint8Array(await recordWav(ms));
        let bin = "";
        for (let k = 0; k < b.length; k += 0x8000) bin += String.fromCharCode(...b.subarray(k, k + 0x8000));
        return btoa(bin);
      }
    : undefined,
};
