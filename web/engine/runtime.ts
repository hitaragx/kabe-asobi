// 遊びを動かす枠：読み込み・切り替え・後片付け・待機状態・エラー時の戻し。

import { type Application, Container, Graphics, Text } from "pixi.js";
import type { GameContext, GameDefinition, GameInstance, Params, Zone } from "./game.ts";
import { Fx } from "./fx.ts";
import type { Hit, WallInput } from "./input.ts";
import { Motion, ease } from "./motion.ts";
import { type MusicStyle, music } from "./music.ts";
import { sound } from "./sound.ts";
import { brights, fontFamily, lineWidth, palette } from "./style.ts";

export interface RuntimeOptions {
  /** 何も当たらない時間がこれを超えたら「あそんでみよう」を出す */
  attractAfterMs: number;
  /** さらにこれを超えたら遊びを最初からにする */
  resetAfterMs: number;
}

export interface RuntimeError {
  game: string;
  where: string;
  message: string;
  at: number;
}

interface Running {
  def: GameDefinition;
  inst: GameInstance | void;
  scope: Scope;
}

/** 1つの遊びが使っているものをまとめ、終わるときに全部片付ける */
class Scope {
  readonly unsubs: (() => void)[] = [];
  readonly timers = new Set<ReturnType<typeof setTimeout>>();
  readonly intervals = new Set<ReturnType<typeof setInterval>>();

  dispose(): void {
    for (const u of this.unsubs) u();
    for (const t of this.timers) clearTimeout(t);
    for (const t of this.intervals) clearInterval(t);
    this.unsubs.length = 0;
    this.timers.clear();
    this.intervals.clear();
  }
}

export class Runtime {
  readonly games = new Map<string, GameDefinition>();
  readonly errors: RuntimeError[] = [];
  /** 遊びを切り替えた順番（戻すときに使う） */
  readonly history: string[] = [];
  current: Running | null = null;
  /** いまの遊びを出した時刻（ミリ秒）。やり直し（値の変更・画面の大きさの変更）でも更新される */
  loadedAt = 0;

  readonly gameLayer = new Container();
  /** 区画の境目と名前（遊びの上、演出の下） */
  readonly zoneLayer = new Container();
  readonly fxLayer = new Container();
  readonly uiLayer = new Container();
  private readonly motion = new Motion();
  private readonly uiMotion = new Motion();
  private readonly fx: Fx;
  private scoreText: Text | null = null;
  private attract: Container | null = null;
  private statusText: Text | null = null;
  private overrides = new Map<string, Record<string, unknown>>();
  /** setup で失敗した遊び。代わりを探すときに、失敗した遊びどうしで堂々めぐりにならないように */
  private readonly failed = new Set<string>();
  private finishing = false;

  constructor(
    private readonly app: Application,
    private readonly input: WallInput,
    private readonly opts: RuntimeOptions = { attractAfterMs: 30000, resetAfterMs: 180000 },
  ) {
    app.stage.addChild(this.gameLayer, this.zoneLayer, this.fxLayer, this.uiLayer);
    this.fx = new Fx(this.fxLayer, this.motion, () => this.unit);
    app.ticker.add((t) => this.tick(t.deltaMS));
    input.onDown(() => this.hideAttract());
    input.onStatus((s) => this.showStatus(s));
    // 画面の大きさが変わったら（全画面にした・窓を動かした）、いまの遊びを今の大きさで作り直す。
    // 遊びは setup のときの大きさで配置を決めるので、そのままだと絵と当たりの位置がずれる
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    app.renderer.on("resize", () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (this.current) this.load(this.current.def.id, false);
      }, 300);
    });
  }

  get width(): number {
    return this.app.screen.width;
  }
  get height(): number {
    return this.app.screen.height;
  }
  get unit(): number {
    return this.height / 100;
  }

  /** 職員が変えた曲の雰囲気（遊びの ID → 雰囲気） */
  private musicStyles: Record<string, MusicStyle> = {};

  /** その遊びで流す曲の雰囲気 */
  musicStyleOf(id: string): MusicStyle {
    return this.musicStyles[id] ?? this.games.get(id)?.music ?? "nonbiri";
  }
  setMusicStyles(styles: Record<string, MusicStyle>): void {
    this.musicStyles = { ...styles };
    if (this.current) music.play(this.musicStyleOf(this.current.def.id), this.current.def.id);
  }

  register(def: GameDefinition): void {
    this.games.set(def.id, def);
  }

  /** 調整できる値を上書きする（MCP・tune から使う）。遊びはやり直しになる */
  setParams(id: string, values: Record<string, unknown>): void {
    this.overrides.set(id, { ...this.overrides.get(id), ...this.clamp(id, values) });
    if (this.current?.def.id === id) this.load(id, false);
  }

  /** いまの値（遊びに書いてある元の値に、上書きを重ねたもの）。zones も含む */
  paramsOf(id: string): Record<string, unknown> {
    const def = this.games.get(id);
    const out: Record<string, unknown> = {};
    if (def) for (const [k, p] of Object.entries(def.params as Params)) out[k] = p.value;
    return Object.assign(out, this.overrides.get(id));
  }

  /** 数の値は min〜max に収める（範囲外の値で遊びが壊れないように）。zones など params にない名前はそのまま */
  private clamp(id: string, values: Record<string, unknown>): Record<string, unknown> {
    const def = this.games.get(id);
    if (!def) return values;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      const p = (def.params as Params)[k];
      if (p && typeof v === "number" && typeof p.value === "number") {
        let n = Number.isFinite(v) ? v : p.value;
        if (p.min !== undefined) n = Math.max(p.min, n);
        if (p.max !== undefined) n = Math.min(p.max, n);
        out[k] = n;
      } else out[k] = v;
    }
    return out;
  }

  /** 遊びを切り替える。失敗したら前の遊びに戻す */
  load(id: string, pushHistory = true): boolean {
    const def = this.games.get(id);
    if (!def) {
      this.recordError(id, "load", `遊びが見つかりません: ${id}`);
      return false;
    }
    const prev = this.current?.def.id ?? null;
    this.unload();
    const scope = new Scope();
    try {
      const ctx = this.makeContext(def, scope);
      const inst = def.setup(ctx);
      this.current = { def, inst, scope };
      this.loadedAt = Date.now();
      music.play(this.musicStyleOf(id), id);
    } catch (e) {
      this.recordError(id, "setup", e);
      this.unload();
      // 壁を空のままにしない：前の遊びに戻す。前の遊びがない（起動直後・値の変更で壊れた）なら、ほかの遊びを出す
      const fallback = prev && prev !== id ? prev : [...this.games.keys()].find((k) => k !== id && !this.failed.has(k));
      this.failed.add(id);
      if (fallback) {
        this.announceUi(prev && prev !== id ? "まえの あそびに もどしました" : "べつの あそびに しました", 2500);
        this.load(fallback, false);
      }
      return false;
    }
    this.failed.delete(id);
    if (pushHistory && this.history.at(-1) !== id) this.history.push(id);
    try {
      localStorage.setItem("kabe.game", id);
    } catch {
      // localStorage が使えなくても動かす
    }
    return true;
  }

  /** ひとつ前の遊びに戻す */
  back(): boolean {
    if (this.history.length < 2) return false;
    this.history.pop();
    return this.load(this.history.at(-1)!, false);
  }

  private unload(): void {
    const cur = this.current;
    this.current = null;
    if (cur) {
      try {
        cur.inst?.destroy?.();
      } catch (e) {
        this.recordError(cur.def.id, "destroy", e);
      }
      cur.scope.dispose();
    }
    this.motion.clear();
    this.fx.clear();
    // 演出（飛び出す文字・波紋など）も片付ける。動きを止めたあとに残ると、次の遊びの画面に居座る
    for (const c of this.fxLayer.removeChildren()) if (!c.destroyed) c.destroy({ children: true });
    for (const c of this.gameLayer.removeChildren()) c.destroy({ children: true });
    for (const c of this.zoneLayer.removeChildren()) c.destroy({ children: true });
    this.setScore(null);
    this.finishing = false;
  }

  private recordError(game: string, where: string, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.errors.push({ game, where, message, at: Date.now() });
    console.error(`[kabe] ${game} ${where}: ${message}`);
  }

  private makeContext(def: GameDefinition, scope: Scope): GameContext {
    const params: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(def.params as Params)) params[k] = p.value;
    Object.assign(params, this.overrides.get(def.id));
    const guard =
      <A extends unknown[]>(where: string, f: (...a: A) => void) =>
      (...a: A) => {
        try {
          f(...a);
        } catch (e) {
          this.recordError(def.id, where, e);
        }
      };
    const u = this.unit;
    const zones = parseZones(params.zones);
    delete params.zones;
    const W = this.width;
    const H = this.height;
    const findZone = (x: number, y: number) => zones.find((z) => x / W >= z.x0 && x / W <= z.x1 && y / H >= z.y0 && y / H <= z.y1);
    this.drawZones(zones);
    return {
      app: this.app,
      stage: this.gameLayer,
      width: this.width,
      height: this.height,
      unit: u,
      params: params as GameContext["params"],
      motion: this.motion,
      fx: this.fx,
      sound,
      colors: palette,
      brights,
      line: lineWidth(this.height),
      onHit: (f) => scope.unsubs.push(this.input.onDown(guard("onHit", f))),
      onRelease: (f) => scope.unsubs.push(this.input.onUp(guard("onRelease", f))),
      touching: () => this.input.points.map((p) => ({ x: p.px, y: p.py, id: p.id })),
      zone: (x, y) => {
        const z = findZone(x, y);
        return { size: z?.size ?? 1, speed: z?.speed ?? 1, label: z?.label };
      },
      zoneRect: (x, y) => {
        const z = findZone(x, y);
        return z ? { x0: z.x0 * W, y0: z.y0 * H, x1: z.x1 * W, y1: z.y1 * H } : { x0: 0, y0: 0, x1: W, y1: H };
      },
      near: (hit, obj, radius, slack = 3) => Math.hypot(hit.x - obj.x, hit.y - obj.y) <= radius + slack * u,
      every: (ms, f) => {
        const t = setInterval(guard("every", f), ms);
        scope.intervals.add(t);
        return () => {
          clearInterval(t);
          scope.intervals.delete(t);
        };
      },
      after: (ms, f) => {
        const t = setTimeout(guard("after", f), ms);
        scope.timers.add(t);
        return () => {
          clearTimeout(t);
          scope.timers.delete(t);
        };
      },
      random: Math.random,
      pick: (arr) => arr[Math.floor(Math.random() * arr.length)]!,
      setScore: (text) => this.setScore(text),
      announce: (text, ms) => this.announceUi(text, ms),
      finish: (afterMs = 4000) => {
        if (this.finishing) return;
        this.finishing = true;
        const t = setTimeout(() => this.current && this.load(this.current.def.id, false), afterMs);
        scope.timers.add(t);
      },
      waitStart: (f, opts = {}) => {
        // 真ん中に案内の札を出す。壁のどこに当てても（タッチでもボールでも）始まる
        const c = new Container();
        c.x = W / 2;
        c.y = H / 2;
        const label = new Text({
          text: opts.text ?? "かべの どこでも\nタッチして スタート！",
          style: { fontFamily, fontSize: Math.min(W, H) * 0.07, fontWeight: "900", fill: palette.ink, align: "center", lineHeight: Math.min(W, H) * 0.1 },
        });
        label.anchor.set(0.5);
        const padX = label.width * 0.12 + u * 3;
        const padY = label.height * 0.25 + u * 2;
        const card = new Graphics()
          .roundRect(-label.width / 2 - padX, -label.height / 2 - padY, label.width + padX * 2, label.height + padY * 2, u * 4)
          .fill(palette.white)
          .stroke({ width: lineWidth(H) * 1.6, color: palette.ink });
        c.addChild(card, label);
        this.gameLayer.addChild(c);
        const stopWobble = this.motion.wobble(c, 0.04, 1600);
        let done = false;
        const off = this.input.onDown(
          guard("waitStart", (hit: Hit) => {
            if (done) return;
            done = true;
            sound.pop();
            this.fx.burst(hit.x, hit.y, { colors: brights, count: 24 });
            cancel();
            f();
          }),
        );
        scope.unsubs.push(off);
        const cancel = () => {
          off();
          stopWobble();
          if (!c.destroyed) c.destroy({ children: true });
        };
        return cancel;
      },
    };
  }

  /** 区画の境目（点線）と名前を薄く出す。子どもにも、どちら側が自分の側か分かるように */
  private drawZones(zones: Zone[]): void {
    if (!zones.length) return;
    const W = this.width;
    const H = this.height;
    const u = this.unit;
    const g = new Graphics();
    const dashed = (x0: number, y0: number, x1: number, y1: number) => {
      const len = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.floor(len / (u * 3));
      for (let i = 0; i < n; i += 2) {
        const a = i / n;
        const b = Math.min(1, (i + 1) / n);
        g.moveTo(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a).lineTo(x0 + (x1 - x0) * b, y0 + (y1 - y0) * b);
      }
    };
    for (const z of zones) {
      // 画面の端と重なる辺は描かない
      if (z.x0 > 0.001) dashed(z.x0 * W, z.y0 * H, z.x0 * W, z.y1 * H);
      if (z.x1 < 0.999) dashed(z.x1 * W, z.y0 * H, z.x1 * W, z.y1 * H);
      if (z.y0 > 0.001) dashed(z.x0 * W, z.y0 * H, z.x1 * W, z.y0 * H);
      if (z.y1 < 0.999) dashed(z.x0 * W, z.y1 * H, z.x1 * W, z.y1 * H);
    }
    g.stroke({ width: u * 0.6, color: palette.white, alpha: 0.8, cap: "round" });
    this.zoneLayer.addChild(g);
    for (const z of zones) {
      if (!z.label) continue;
      const t = this.text(z.label, 3.6, palette.white);
      t.alpha = 0.85;
      t.x = ((z.x0 + z.x1) / 2) * W;
      t.y = z.y1 * H - u * 4;
      this.zoneLayer.addChild(t);
    }
  }

  private tick(dtMs: number): void {
    const dt = Math.min(dtMs, 100);
    this.motion.update(dt);
    this.uiMotion.update(dt);
    this.fx.update(dt);
    const cur = this.current;
    if (cur?.inst?.update) {
      try {
        cur.inst.update(dt);
      } catch (e) {
        this.recordError(cur.def.id, "update", e);
        // 毎フレーム同じエラーを出し続けないよう、前の遊びに戻す
        if (!this.back()) this.unload();
        this.announceUi("まえの あそびに もどしました", 2500);
      }
    }
    // 待機状態
    const idle = performance.now() - this.input.lastInputAt;
    if (idle > this.opts.attractAfterMs && !this.attract) this.showAttract();
    music.setIdle(idle > this.opts.attractAfterMs);
    if (idle > this.opts.resetAfterMs && cur) {
      this.input.lastInputAt = performance.now() - this.opts.attractAfterMs;
      this.load(cur.def.id, false);
    }
  }

  // ---- 画面の上に重ねる表示 ----

  private text(s: string, size: number, color: number = palette.white): Text {
    const u = this.unit;
    const t = new Text({
      text: s,
      style: { fontFamily, fontSize: size * u, fontWeight: "900", fill: color, stroke: { color: palette.ink, width: u * 1.2 }, align: "center" },
    });
    t.anchor.set(0.5);
    return t;
  }

  setScore(s: string | null): void {
    if (s === null) {
      this.scoreText?.destroy();
      this.scoreText = null;
      return;
    }
    if (!this.scoreText) {
      this.scoreText = this.text(s, 7, palette.yellow);
      this.scoreText.x = this.width / 2;
      this.scoreText.y = this.unit * 7;
      this.uiLayer.addChild(this.scoreText);
    }
    if (this.scoreText.text !== s) {
      this.scoreText.text = s;
      void this.uiMotion.squash(this.scoreText, 0.15, 250);
    }
  }

  announceUi(s: string, ms = 2000): void {
    const t = this.text(s, 12);
    t.x = this.width / 2;
    t.y = this.height / 2;
    this.uiLayer.addChild(t);
    void this.uiMotion.popIn(t, 400).then(async () => {
      await this.uiMotion.wait(ms);
      await this.uiMotion.to(t, { alpha: 0 }, 300);
      t.destroy();
    });
  }

  private showAttract(): void {
    const c = new Container();
    const t = this.text(this.current?.def.input === "タッチ" ? "さわってみよう！" : "ボールを なげてみよう！", 10);
    c.addChild(t);
    c.x = this.width / 2;
    c.y = this.height * 0.82;
    this.uiLayer.addChild(c);
    this.attract = c;
    void this.uiMotion.popIn(c, 500);
    this.uiMotion.loop((_dt, time) => {
      if (c.destroyed) return false;
      t.y = Math.sin(time / 300) * this.unit * 1.5;
    });
  }

  private hideAttract(): void {
    const c = this.attract;
    if (!c) return;
    this.attract = null;
    void this.uiMotion.to(c, { alpha: 0 }, 200, ease.linear).then(() => c.destroy({ children: true }));
  }

  private showStatus(s: string): void {
    this.statusText?.destroy();
    this.statusText = null;
    if (s === "ok") return;
    const msg = s === "lost" ? "センサーを さがしています…" : "じゅんびちゅう…";
    const t = this.text(msg, 3.2, palette.white);
    t.alpha = 0.7;
    t.anchor.set(1, 1);
    t.x = this.width - this.unit * 2;
    t.y = this.height - this.unit * 2;
    this.uiLayer.addChild(t);
    this.statusText = t;
  }
}

/** 区画の設定を確かめて取り出す（壊れた値は無視する） */
function parseZones(v: unknown): Zone[] {
  if (!Array.isArray(v)) return [];
  const num = (x: unknown, lo: number, hi: number, d: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
  return v
    .filter((z): z is Record<string, unknown> => typeof z === "object" && z !== null)
    .map((z) => ({
      x0: num(z.x0, 0, 1, 0),
      y0: num(z.y0, 0, 1, 0),
      x1: num(z.x1, 0, 1, 1),
      y1: num(z.y1, 0, 1, 1),
      size: num(z.size, 0.3, 3, 1),
      speed: num(z.speed, 0, 3, 1),
      label: typeof z.label === "string" ? z.label.slice(0, 20) : undefined,
    }))
    .filter((z) => z.x1 > z.x0 && z.y1 > z.y0);
}
