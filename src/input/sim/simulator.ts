// 模擬スキャン。センサーがない平日でも、本物に近いデータで開発・検証できるようにする。
//
// 壁の座標（メートル）：投影範囲の左上が原点、x は右、y は下向き。
// センサーは壁の面と平行に、壁の少し手前を走査する。壁に当たったボールや手は、
// その面を一瞬だけ横切る「小さな円」として見える。

import { type Scan, type ScanSpec, UST_20LX, stepAngle } from "../scan.ts";

export interface SensorPose {
  /** 壁の座標でのセンサーの位置（メートル） */
  x: number;
  y: number;
  /** センサーの正面が向く方向（壁の座標でのラジアン。0 は右、π/2 は下） */
  heading: number;
  /** センサーを裏返しに付けた場合（左右が反転する） */
  mirrored: boolean;
}

export interface SimObject {
  kind: "ball" | "hand";
  /** 壁の座標（メートル） */
  x: number;
  y: number;
  /** 断面の半径（メートル） */
  radius: number;
  /** 面に現れている時間 [t0, t1)（ミリ秒、シミュレーション開始からの経過） */
  t0: number;
  t1: number;
  /** 手を動かす場合の速度（メートル/秒） */
  vx?: number;
  vy?: number;
}

export interface SimOptions {
  spec?: ScanSpec;
  /** 投影範囲の大きさ（メートル） */
  wallWidth?: number;
  wallHeight?: number;
  pose?: Partial<SensorPose>;
  /** 距離のばらつき（mm、標準偏差） */
  noiseMm?: number;
  /** 測れない点が出る割合 */
  dropoutRate?: number;
  seed?: number;
}

/** 再現できる乱数（mulberry32） */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class Simulator {
  readonly spec: ScanSpec;
  readonly wallWidth: number;
  readonly wallHeight: number;
  readonly pose: SensorPose;
  private readonly noiseMm: number;
  private readonly dropoutRate: number;
  private readonly rng: () => number;
  private objects: SimObject[] = [];
  /** 部屋の壁・床・天井（背景）。壁の座標での範囲 */
  private readonly room: { left: number; right: number; top: number; bottom: number };

  constructor(opts: SimOptions = {}) {
    this.spec = opts.spec ?? UST_20LX;
    this.wallWidth = opts.wallWidth ?? 2.4;
    this.wallHeight = opts.wallHeight ?? 1.5;
    // 既定：投影範囲の上辺の中央、少し上に付けて下向きに走査する
    this.pose = {
      x: this.wallWidth / 2,
      y: -0.1,
      heading: Math.PI / 2,
      mirrored: false,
      ...opts.pose,
    };
    this.noiseMm = opts.noiseMm ?? 12;
    this.dropoutRate = opts.dropoutRate ?? 0.002;
    this.rng = makeRng(opts.seed ?? 1);
    this.room = { left: -1.2, right: this.wallWidth + 1.2, top: -0.35, bottom: this.wallHeight + 0.5 };
  }

  add(obj: SimObject): void {
    this.objects.push(obj);
  }

  /** 時刻 t（ミリ秒）に面に現れている物体と、その位置 */
  activeAt(t: number): SimObject[] {
    return this.objects
      .filter((o) => t >= o.t0 && t < o.t1)
      .map((o) => {
        const dt = (t - o.t0) / 1000;
        return { ...o, x: o.x + (o.vx ?? 0) * dt, y: o.y + (o.vy ?? 0) * dt };
      });
  }

  /** 終わった物体を捨てる（長時間動かすとき用） */
  prune(t: number): void {
    this.objects = this.objects.filter((o) => o.t1 > t);
  }

  /** センサーの点の番号 → 壁の座標での光線の向き */
  private rayDir(step: number): { dx: number; dy: number } {
    let a = stepAngle(this.spec, step);
    if (this.pose.mirrored) a = -a;
    const h = this.pose.heading + a;
    return { dx: Math.cos(h), dy: Math.sin(h) };
  }

  /** 時刻 t（ミリ秒）のスキャンを作る */
  scanAt(t: number, seq: number, epochMs = 0): Scan {
    const active = this.activeAt(t);
    const ranges = new Array<number>(this.spec.steps);
    const { x: sx, y: sy } = this.pose;
    for (let i = 0; i < this.spec.steps; i++) {
      const { dx, dy } = this.rayDir(i);
      let best = this.backgroundDistance(sx, sy, dx, dy);
      for (const o of active) {
        const d = rayCircle(sx, sy, dx, dy, o.x, o.y, o.radius);
        if (d !== null && d < best) best = d;
      }
      let mm = best * 1000 + gaussian(this.rng) * this.noiseMm;
      if (mm < this.spec.minRange || mm > this.spec.maxRange || this.rng() < this.dropoutRate) mm = 0;
      ranges[i] = Math.round(mm);
    }
    return { seq, t: epochMs + t, ranges };
  }

  /** 部屋の境界（長方形）までの距離 */
  private backgroundDistance(sx: number, sy: number, dx: number, dy: number): number {
    const { left, right, top, bottom } = this.room;
    let best = Infinity;
    if (dx > 1e-9) best = Math.min(best, (right - sx) / dx);
    if (dx < -1e-9) best = Math.min(best, (left - sx) / dx);
    if (dy > 1e-9) best = Math.min(best, (bottom - sy) / dy);
    if (dy < -1e-9) best = Math.min(best, (top - sy) / dy);
    return best;
  }

  /** 正解：センサー座標（メートル）→ 壁の座標（メートル） */
  sensorToWall(x: number, y: number): { x: number; y: number } {
    const yy = this.pose.mirrored ? -y : y;
    const c = Math.cos(this.pose.heading);
    const s = Math.sin(this.pose.heading);
    return { x: this.pose.x + x * c - yy * s, y: this.pose.y + x * s + yy * c };
  }

  /** 正解：壁の座標（メートル）→ 画面の正規化座標（0〜1） */
  wallToScreen(x: number, y: number): { x: number; y: number } {
    return { x: x / this.wallWidth, y: y / this.wallHeight };
  }

  /** 正解のセンサー座標 → 画面座標の射影変換（行優先の3×3） */
  trueHomography(): number[] {
    const c = Math.cos(this.pose.heading);
    const s = Math.sin(this.pose.heading);
    const m = this.pose.mirrored ? -1 : 1;
    const W = this.wallWidth;
    const H = this.wallHeight;
    return [c / W, (-s * m) / W, this.pose.x / W, s / H, (c * m) / H, this.pose.y / H, 0, 0, 1];
  }
}

/** 光線と円の交点までの距離（最初に当たる点）。当たらなければ null */
export function rayCircle(
  sx: number,
  sy: number,
  dx: number,
  dy: number,
  cx: number,
  cy: number,
  r: number,
): number | null {
  const ox = sx - cx;
  const oy = sy - cy;
  const b = ox * dx + oy * dy;
  const c = ox * ox + oy * oy - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = -b - sq;
  if (t1 > 0) return t1;
  const t2 = -b + sq;
  return t2 > 0 ? t2 : null;
}

// ---- よく使う場面 ----

export const BALL_RADIUS = 0.035; // 柔らかいボール（直径7cm）
export const HAND_RADIUS = 0.04;

/** ボールが壁に当たる：面を横切るのは数十ミリ秒だけ */
export function ballHit(x: number, y: number, t0: number, durationMs = 40): SimObject {
  return { kind: "ball", x, y, radius: BALL_RADIUS, t0, t1: t0 + durationMs };
}

/** 手で触れる。vx, vy を与えるとなぞる動きになる */
export function handTouch(x: number, y: number, t0: number, durationMs = 400, vx = 0, vy = 0): SimObject {
  return { kind: "hand", x, y, radius: HAND_RADIUS, t0, t1: t0 + durationMs, vx, vy };
}

/**
 * 子どもたちが次々にボールを投げる場面を作る。
 * players 人がそれぞれ平均 intervalMs ごとに投げ、当たる位置は各自の得意な辺りにばらつく。
 */
export function addRandomBalls(
  sim: Simulator,
  opts: { startMs: number; durationMs: number; players?: number; intervalMs?: number; seed?: number },
): SimObject[] {
  const rng = makeRng(opts.seed ?? 7);
  const players = opts.players ?? 3;
  const interval = opts.intervalMs ?? 1500;
  const added: SimObject[] = [];
  for (let p = 0; p < players; p++) {
    const cx = ((p + 0.5) / players) * sim.wallWidth;
    let t = opts.startMs + rng() * interval;
    while (t < opts.startMs + opts.durationMs) {
      const x = clamp(cx + (rng() - 0.5) * sim.wallWidth * 0.5, 0.05, sim.wallWidth - 0.05);
      const y = clamp(0.15 + rng() * (sim.wallHeight - 0.3), 0.05, sim.wallHeight - 0.05);
      const obj = ballHit(x, y, t, 25 + rng() * 40);
      sim.add(obj);
      added.push(obj);
      t += interval * (0.5 + rng());
    }
  }
  return added;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
