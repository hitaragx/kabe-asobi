import { Container, Graphics } from "pixi.js";
import { sky } from "../engine/draw.ts";
import { defineGame } from "../engine/game.ts";

export default defineGame({
  id: "bubbles",
  title: "シャボンだま ぱちん！",
  description: "シャボン玉が ふわふわ ただよっている。手で さわると「ぱちん！」と われて、きらきらと 音が出る。勝ち負けはなく、ずっと遊べる。",
  rule: "終わりのない遊び",
  ages: "2歳〜",
  input: "タッチ",
  params: {
    size: { value: 1, label: "シャボン玉の大きさ", min: 0.5, max: 2 },
    speed: { value: 1, label: "シャボン玉の速さ", min: 0, max: 2.5 },
    count: { value: 7, label: "いちどに出るシャボン玉の数", min: 2, max: 15 },
    /** 小さい子の手が届く高さに置く（0=上、1=下） */
    top: { value: 0.45, label: "シャボン玉がいる高さ（上のはし）", min: 0.05, max: 0.7 },
    bottom: { value: 0.92, label: "シャボン玉がいる高さ（下のはし）", min: 0.4, max: 0.98 },
  },

  setup(ctx) {
    const { unit, width, height, params } = ctx;
    const baseR = unit * 8 * params.size;
    const topY = height * Math.min(params.top, params.bottom - 0.1);
    const bottomY = height * params.bottom;

    const bg = sky(width, height, ctx.line, 0x9fdcff, 0xeef9ff, 3);
    ctx.stage.addChild(bg);
    for (const cl of bg.children) if (cl.label === "cloud") ctx.motion.drift(cl, unit * (1 + ctx.random()), 0);

    type Bubble = { c: Container; r: number; vx: number; vy: number; color: number; stop: () => void };
    const bubbles = new Set<Bubble>();
    const colors = ctx.brights;
    let noteIndex = 0;

    const makeBubble = (r: number, color: number): Container => {
      const c = new Container();
      const g = new Graphics();
      // うすく色のついた玉と、太い輪郭
      g.circle(0, 0, r).fill({ color, alpha: 0.35 }).stroke({ width: ctx.line, color });
      g.circle(0, 0, r).stroke({ width: ctx.line * 0.5, color: ctx.colors.white, alpha: 0.8 });
      // ひかり
      g.ellipse(-r * 0.38, -r * 0.4, r * 0.22, r * 0.13).fill({ color: ctx.colors.white, alpha: 0.95 });
      g.circle(-r * 0.12, -r * 0.62, r * 0.07).fill({ color: ctx.colors.white, alpha: 0.95 });
      c.addChild(g);
      return c;
    };

    const spawn = () => {
      if (bubbles.size >= params.count) return;
      const x = baseR * 1.5 + ctx.random() * (width - baseR * 3);
      const y = topY + baseR + ctx.random() * Math.max(1, bottomY - topY - baseR * 2);
      const z = ctx.zone(x, y);
      const r = baseR * z.size * (0.8 + ctx.random() * 0.4);
      const area = ctx.zoneRect(x, y);
      const x0 = area.x0 + r;
      const x1 = area.x1 - r;
      const y0 = Math.max(area.y0, topY) + r;
      const y1 = Math.min(area.y1, bottomY) - r;
      const color = ctx.pick(colors);
      const c = makeBubble(r, color);
      c.x = Math.min(Math.max(x, x0), x1);
      c.y = Math.min(Math.max(y, y0), Math.max(y0, y1));
      ctx.stage.addChild(c);
      void ctx.motion.popIn(c, 500);
      const sp = unit * (3 + ctx.random() * 3) * params.speed * z.speed;
      const ang = ctx.random() * Math.PI * 2;
      const b: Bubble = { c, r, color, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, stop: () => {} };
      const phase = ctx.random() * Math.PI * 2;
      b.stop = ctx.motion.loop((dt, time) => {
        if (c.destroyed) return false;
        c.x += (b.vx * dt) / 1000;
        c.y += (b.vy * dt) / 1000;
        if (c.x < x0) b.vx = Math.abs(b.vx);
        if (c.x > x1) b.vx = -Math.abs(b.vx);
        if (c.y < y0) b.vy = Math.abs(b.vy);
        if (c.y > y1) b.vy = -Math.abs(b.vy);
        // ふわふわ ゆれる
        const s = Math.sin(time / 500 + phase) * 0.04;
        c.scale.set(1 + s, 1 - s);
        return true;
      });
      bubbles.add(b);
    };

    // シャボン玉どうしが重ならないよう、ふれたら やさしく はね返る
    ctx.motion.loop(() => {
      const list = [...bubbles];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]!;
          const b = list[j]!;
          const dx = b.c.x - a.c.x;
          const dy = b.c.y - a.c.y;
          const d = Math.hypot(dx, dy) || 1;
          const min = (a.r + b.r) * 1.05;
          if (d >= min) continue;
          const nx = dx / d;
          const ny = dy / d;
          const push = (min - d) / 2;
          a.c.x -= nx * push;
          a.c.y -= ny * push;
          b.c.x += nx * push;
          b.c.y += ny * push;
          const va = a.vx * nx + a.vy * ny;
          const vb = b.vx * nx + b.vy * ny;
          if (va - vb > 0) {
            a.vx += (vb - va) * nx;
            a.vy += (vb - va) * ny;
            b.vx += (va - vb) * nx;
            b.vy += (va - vb) * ny;
          }
        }
      }
      return true;
    });

    for (let i = 0; i < params.count; i++) ctx.after(i * 250, spawn);
    ctx.every(700, spawn);

    ctx.onHit((hit) => {
      let best: Bubble | null = null;
      let bestD = Infinity;
      for (const b of bubbles) {
        const d = Math.hypot(hit.x - b.c.x, hit.y - b.c.y);
        if (d < bestD && ctx.near(hit, b.c, b.r * 1.2)) {
          best = b;
          bestD = d;
        }
      }
      if (!best) {
        ctx.fx.ripple(hit.x, hit.y, { radius: 6 });
        return;
      }
      const b = best;
      bubbles.delete(b);
      b.stop();
      ctx.sound.pop();
      ctx.sound.note(noteIndex++ % 8);
      ctx.fx.burst(b.c.x, b.c.y, { color: b.color, count: 16 });
      ctx.fx.popText(b.c.x, b.c.y - b.r, "ぱちん！");
      void ctx.motion.to(b.c, { scale: 1.4, alpha: 0 }, 180).then(() => {
        if (!b.c.destroyed) b.c.destroy({ children: true });
      });
    });
  },
});
