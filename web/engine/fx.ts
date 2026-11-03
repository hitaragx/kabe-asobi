// 当たったときの演出。遊びは ctx.fx から使う。

import { Container, Graphics, Text } from "pixi.js";
import { type Motion, ease } from "./motion.ts";
import { brights, fontFamily, palette } from "./style.ts";

interface Particle {
  g: Graphics;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  spin: number;
  gravity: number;
}

export class Fx {
  private particles: Particle[] = [];

  constructor(
    private readonly layer: Container,
    private readonly motion: Motion,
    private readonly unit: () => number,
  ) {}

  /** 枠が毎フレーム呼ぶ */
  update(dtMs: number): void {
    const dt = dtMs / 1000;
    for (const p of this.particles.slice()) {
      p.life += dtMs;
      p.vy += p.gravity * dt;
      p.g.x += p.vx * dt;
      p.g.y += p.vy * dt;
      p.g.rotation += p.spin * dt;
      const k = p.life / p.maxLife;
      p.g.alpha = 1 - k * k;
      if (p.life >= p.maxLife) {
        p.g.destroy();
        this.particles.splice(this.particles.indexOf(p), 1);
      }
    }
  }

  clear(): void {
    for (const p of this.particles) p.g.destroy();
    this.particles = [];
  }

  /** はじけて粒が飛び散る */
  burst(x: number, y: number, opts: { color?: number; colors?: number[]; count?: number; size?: number; speed?: number } = {}): void {
    const u = this.unit();
    const count = opts.count ?? 18;
    const colors = opts.colors ?? (opts.color !== undefined ? [opts.color, palette.white] : brights);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const sp = (opts.speed ?? 1) * u * (25 + Math.random() * 35);
      const s = (opts.size ?? 1) * u * (0.8 + Math.random() * 1.2);
      const g = new Graphics();
      const c = colors[i % colors.length]!;
      if (i % 3 === 0) g.star(0, 0, 5, s * 1.4, s * 0.6).fill(c);
      else g.circle(0, 0, s).fill(c);
      g.x = x;
      g.y = y;
      this.layer.addChild(g);
      this.particles.push({ g, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, maxLife: 600 + Math.random() * 400, spin: (Math.random() - 0.5) * 10, gravity: u * 60 });
    }
  }

  /** 波紋が広がる */
  ripple(x: number, y: number, opts: { color?: number; radius?: number; ms?: number } = {}): void {
    const u = this.unit();
    const g = new Graphics().circle(0, 0, (opts.radius ?? 12) * u).stroke({ width: u * 1.2, color: opts.color ?? palette.white });
    g.x = x;
    g.y = y;
    g.scale.set(0.1);
    this.layer.addChild(g);
    void this.motion.to(g, { scale: 1, alpha: 0 }, opts.ms ?? 600, ease.outQuad).then(() => g.destroy());
  }

  /** 文字が飛び出して消える（点数など） */
  popText(x: number, y: number, text: string, opts: { color?: number; size?: number } = {}): void {
    const u = this.unit();
    const t = new Text({
      text,
      style: {
        fontFamily,
        fontSize: (opts.size ?? 8) * u,
        fontWeight: "900",
        fill: opts.color ?? palette.yellow,
        stroke: { color: palette.ink, width: u * 1.2 },
      },
    });
    t.anchor.set(0.5);
    t.x = x;
    t.y = y;
    this.layer.addChild(t);
    void this.motion.popIn(t, 250).then(async () => {
      await this.motion.to(t, { y: y - u * 12, alpha: 0 }, 700, ease.inQuad);
      t.destroy();
    });
  }

  /** 紙吹雪（できた！のとき） */
  confetti(width: number, count = 80): void {
    const u = this.unit();
    for (let i = 0; i < count; i++) {
      const g = new Graphics().rect(-u, -u * 0.5, u * 2, u).fill(brights[i % brights.length]!);
      g.x = Math.random() * width;
      g.y = -Math.random() * u * 30;
      this.layer.addChild(g);
      this.particles.push({ g, vx: (Math.random() - 0.5) * u * 20, vy: u * (10 + Math.random() * 20), life: 0, maxLife: 2500 + Math.random() * 1500, spin: (Math.random() - 0.5) * 12, gravity: u * 8 });
    }
  }
}
