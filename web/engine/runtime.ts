// 遊びを動かす枠：読み込み・切り替え・後片付け・待機状態・エラー時の戻し。

import { type Application, Container, Text } from "pixi.js";
import type { GameContext, GameDefinition, GameInstance, Params } from "./game.ts";
import { Fx } from "./fx.ts";
import type { Hit, WallInput } from "./input.ts";
import { Motion, ease } from "./motion.ts";
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

  readonly gameLayer = new Container();
  readonly fxLayer = new Container();
  readonly uiLayer = new Container();
  private readonly motion = new Motion();
  private readonly uiMotion = new Motion();
  private readonly fx: Fx;
  private scoreText: Text | null = null;
  private attract: Container | null = null;
  private statusText: Text | null = null;
  private overrides = new Map<string, Record<string, unknown>>();
  private finishing = false;

  constructor(
    private readonly app: Application,
    private readonly input: WallInput,
    private readonly opts: RuntimeOptions = { attractAfterMs: 30000, resetAfterMs: 180000 },
  ) {
    app.stage.addChild(this.gameLayer, this.fxLayer, this.uiLayer);
    this.fx = new Fx(this.fxLayer, this.motion, () => this.unit);
    app.ticker.add((t) => this.tick(t.deltaMS));
    input.onDown(() => this.hideAttract());
    input.onStatus((s) => this.showStatus(s));
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

  register(def: GameDefinition): void {
    this.games.set(def.id, def);
  }

  /** 調整できる値を上書きする（MCP・tune から使う）。遊びはやり直しになる */
  setParams(id: string, values: Record<string, unknown>): void {
    this.overrides.set(id, { ...this.overrides.get(id), ...values });
    if (this.current?.def.id === id) this.load(id, false);
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
    } catch (e) {
      this.recordError(id, "setup", e);
      this.unload();
      if (prev && prev !== id) {
        this.announceUi("まえの あそびに もどしました", 2500);
        this.load(prev, false);
      }
      return false;
    }
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
    for (const c of this.gameLayer.removeChildren()) c.destroy({ children: true });
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
    };
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
