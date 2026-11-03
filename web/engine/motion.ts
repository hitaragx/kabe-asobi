// 動きの部品。遊びは ctx.motion から使う。
// 遊びが終わると、動きはすべて枠が自動で止める。

import type { Container } from "pixi.js";

export type Ease = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  inQuad: (t: number) => t * t,
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  /** 少し行き過ぎて戻る（ぽんっと出る） */
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
  /** びよーんと揺れて止まる */
  outElastic: (t: number) => {
    if (t === 0 || t === 1) return t;
    return 2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * (2 * Math.PI)) / 3) + 1;
  },
  /** 床で弾むように止まる */
  outBounce: (t: number) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
};

type Props = Partial<Record<"x" | "y" | "alpha" | "rotation" | "scale" | "scaleX" | "scaleY", number>>;

interface Tween {
  obj: Container;
  from: Record<string, number>;
  to: Record<string, number>;
  ms: number;
  elapsed: number;
  ease: Ease;
  done: () => void;
}

/** 毎フレーム呼ばれる動き。false を返すと終わる */
type Behavior = (dtMs: number, timeMs: number) => boolean | void;

function get(obj: Container, k: string): number {
  if (k === "scale" || k === "scaleX") return obj.scale.x;
  if (k === "scaleY") return obj.scale.y;
  return (obj as unknown as Record<string, number>)[k]!;
}

function set(obj: Container, k: string, v: number): void {
  if (k === "scale") obj.scale.set(v);
  else if (k === "scaleX") obj.scale.x = v;
  else if (k === "scaleY") obj.scale.y = v;
  else (obj as unknown as Record<string, number>)[k] = v;
}

export class Motion {
  private tweens: Tween[] = [];
  private behaviors = new Set<Behavior>();
  private time = 0;

  /** 枠が毎フレーム呼ぶ */
  update(dtMs: number): void {
    this.time += dtMs;
    for (const tw of this.tweens.slice()) {
      if (tw.obj.destroyed) {
        this.tweens.splice(this.tweens.indexOf(tw), 1);
        continue;
      }
      tw.elapsed += dtMs;
      const p = Math.min(1, tw.elapsed / tw.ms);
      const e = tw.ease(p);
      for (const k of Object.keys(tw.to)) set(tw.obj, k, tw.from[k]! + (tw.to[k]! - tw.from[k]!) * e);
      if (p >= 1) {
        this.tweens.splice(this.tweens.indexOf(tw), 1);
        tw.done();
      }
    }
    for (const b of [...this.behaviors]) if (b(dtMs, this.time) === false) this.behaviors.delete(b);
  }

  /** すべて止める（遊びの終わりに枠が呼ぶ） */
  clear(): void {
    this.tweens = [];
    this.behaviors.clear();
  }

  /** 毎フレームの動きを足す。戻り値を呼ぶと止まる */
  loop(b: Behavior): () => void {
    this.behaviors.add(b);
    return () => this.behaviors.delete(b);
  }

  /** obj の値を ms ミリ秒かけて変える */
  to(obj: Container, props: Props, ms: number, e: Ease = ease.outQuad): Promise<void> {
    // 同じ値を動かしている途中の動きは止める
    this.tweens = this.tweens.filter((t) => !(t.obj === obj && Object.keys(props).some((k) => k in t.to)));
    return new Promise((resolve) => {
      const from: Record<string, number> = {};
      for (const k of Object.keys(props)) from[k] = get(obj, k);
      this.tweens.push({ obj, from, to: props as Record<string, number>, ms: Math.max(1, ms), elapsed: 0, ease: e, done: resolve });
    });
  }

  /** ぽんっと出てくる（大きさ 0 → 元の大きさ） */
  popIn(obj: Container, ms = 400, scale = 1): Promise<void> {
    obj.scale.set(0);
    return this.to(obj, { scale }, ms, ease.outBack);
  }

  /** すっと消える */
  popOut(obj: Container, ms = 250): Promise<void> {
    return this.to(obj, { scale: 0, alpha: 0 }, ms, ease.inQuad);
  }

  /** 押しつぶれて戻る（当たったときの手ごたえ） */
  async squash(obj: Container, amount = 0.3, ms = 350): Promise<void> {
    const sx = obj.scale.x;
    const sy = obj.scale.y;
    await this.to(obj, { scaleX: sx * (1 + amount), scaleY: sy * (1 - amount) }, ms * 0.25, ease.outQuad);
    await this.to(obj, { scaleX: sx, scaleY: sy }, ms * 0.75, ease.outElastic);
  }

  /** その場で跳ねる */
  async hop(obj: Container, height = 40, ms = 450): Promise<void> {
    const y = obj.y;
    await this.to(obj, { y: y - height }, ms * 0.4, ease.outQuad);
    await this.to(obj, { y }, ms * 0.6, ease.outBounce);
  }

  /** ぶるぶる震える */
  shake(obj: Container, amount = 8, ms = 300): Promise<void> {
    const x0 = obj.x;
    let t = 0;
    return new Promise((resolve) => {
      this.loop((dt) => {
        t += dt;
        if (obj.destroyed) return false;
        if (t >= ms) {
          obj.x = x0;
          resolve();
          return false;
        }
        obj.x = x0 + Math.sin(t / 15) * amount * (1 - t / ms);
      });
    });
  }

  /** ふわふわ上下に漂う（ずっと続く） */
  float(obj: Container, amp = 10, periodMs = 2000, phase = Math.random() * Math.PI * 2): () => void {
    const y0 = obj.y;
    return this.loop((_dt, time) => {
      if (obj.destroyed) return false;
      obj.y = y0 + Math.sin((time / periodMs) * Math.PI * 2 + phase) * amp;
    });
  }

  /** ゆらゆら左右に傾く（ずっと続く） */
  wobble(obj: Container, angle = 0.1, periodMs = 1500, phase = Math.random() * Math.PI * 2): () => void {
    return this.loop((_dt, time) => {
      if (obj.destroyed) return false;
      obj.rotation = Math.sin((time / periodMs) * Math.PI * 2 + phase) * angle;
    });
  }

  /** 決まった速さで進む（vx, vy はピクセル/秒）。画面の外に出たら onExit */
  drift(
    obj: Container,
    vx: number,
    vy: number,
    bounds?: { width: number; height: number; margin?: number; onExit?: () => void },
  ): () => void {
    return this.loop((dt) => {
      if (obj.destroyed) return false;
      obj.x += (vx * dt) / 1000;
      obj.y += (vy * dt) / 1000;
      if (bounds) {
        const m = bounds.margin ?? 200;
        if (obj.x < -m || obj.x > bounds.width + m || obj.y < -m || obj.y > bounds.height + m) {
          bounds.onExit?.();
          return false;
        }
      }
    });
  }

  /** 決まった道筋（点の列）をたどる。loop なら繰り返す */
  path(obj: Container, points: { x: number; y: number }[], speed: number, loop = true): () => void {
    let i = 0;
    return this.loop((dt) => {
      if (obj.destroyed || points.length < 2) return false;
      let remain = (speed * dt) / 1000;
      while (remain > 0) {
        const next = points[(i + 1) % points.length]!;
        const dx = next.x - obj.x;
        const dy = next.y - obj.y;
        const d = Math.hypot(dx, dy);
        if (d <= remain) {
          obj.x = next.x;
          obj.y = next.y;
          remain -= d;
          i++;
          if (!loop && i >= points.length - 1) return false;
          i %= points.length;
        } else {
          obj.x += (dx / d) * remain;
          obj.y += (dy / d) * remain;
          remain = 0;
        }
      }
    });
  }

  /** 指定した点から逃げる（近づくと離れる） */
  flee(obj: Container, from: () => { x: number; y: number }[], radius: number, speed: number): () => void {
    return this.loop((dt) => {
      if (obj.destroyed) return false;
      for (const p of from()) {
        const dx = obj.x - p.x;
        const dy = obj.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d > 0 && d < radius) {
          obj.x += (dx / d) * ((speed * dt) / 1000);
          obj.y += (dy / d) * ((speed * dt) / 1000);
        }
      }
    });
  }

  /** まばたき。face()（draw.ts）で作った顔に使う */
  async blink(faceC: Container): Promise<void> {
    const eyes = faceC.getChildByLabel("eyes");
    if (!eyes || eyes.destroyed) return;
    await this.to(eyes, { scaleY: 0.1 }, 60, ease.linear);
    await this.to(eyes, { scaleY: 1 }, 90, ease.outQuad);
  }

  /** ms ミリ秒待つ */
  wait(ms: number): Promise<void> {
    let t = 0;
    return new Promise((resolve) => {
      this.loop((dt) => {
        t += dt;
        if (t >= ms) {
          resolve();
          return false;
        }
      });
    });
  }
}
