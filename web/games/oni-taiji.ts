import { Container, Graphics } from "pixi.js";
import { blobShape, face, sky } from "../engine/draw.ts";
import { defineGame } from "../engine/game.ts";

export default defineGame({
  id: "oni-taiji",
  title: "おにはそと！",
  description: "にこにこ顔の 鬼が ゆっくり 歩いている。ボールを当てると「おにはそと！」と にげていく。勝ち負けはなく、みんなで当てた数を数える。",
  rule: "的当て",
  ages: "3歳〜",
  input: "ボール",
  music: "wa",
  params: {
    size: { value: 1, label: "鬼の大きさ", min: 0.5, max: 2 },
    speed: { value: 1, label: "鬼の歩く速さ", min: 0, max: 2.5 },
    count: { value: 4, label: "いちどに出る鬼の数", min: 1, max: 8 },
    /** 鬼がいる高さの範囲（0=上、1=下）。床すれすれには来ないようにする */
    top: { value: 0.2, label: "鬼がいる高さ（上のはし）", min: 0.1, max: 0.6 },
    bottom: { value: 0.62, label: "鬼がいる高さ（下のはし）", min: 0.3, max: 0.8 },
    showCount: { value: true, label: "みんなで当てた数を出す" },
  },

  setup(ctx) {
    const { unit, width, height, params } = ctx;
    const r = unit * 9 * params.size;
    const top = height * Math.min(params.top, params.bottom - 0.05) + r * 1.2;
    const bottom = Math.max(top, height * params.bottom);

    const bg = sky(width, height, ctx.line, 0x7fd0ff, 0xe4f6ff, 3);
    ctx.stage.addChild(bg);
    for (const cl of bg.children) if (cl.label === "cloud") ctx.motion.drift(cl, unit * (1 + ctx.random()), 0);

    let total = 0;
    if (params.showCount) ctx.setScore("みんなで 0");

    type Oni = { c: Container; face: Container; vx: number; r: number; stop: () => void };
    const onis = new Set<Oni>();
    const colors = [ctx.colors.red, ctx.colors.blue, ctx.colors.green, ctx.colors.orange, ctx.colors.purple];

    const makeOni = (color: number, r: number): { c: Container; face: Container } => {
      const c = new Container();
      const horn = color === ctx.colors.yellow ? ctx.colors.white : ctx.colors.yellow;
      // つの
      const horns = blobShape(
        (g) => {
          g.poly([-r * 0.55, -r * 0.6, -r * 0.25, -r * 0.85, -r * 0.5, -r * 1.25]);
          g.poly([r * 0.55, -r * 0.6, r * 0.25, -r * 0.85, r * 0.5, -r * 1.25]);
        },
        horn,
        ctx.line,
      );
      // からだ（まるい）と小さい手
      const body = blobShape(
        (g) => {
          g.circle(0, 0, r);
          g.circle(-r * 0.95, r * 0.25, r * 0.28);
          g.circle(r * 0.95, r * 0.25, r * 0.28);
        },
        color,
        ctx.line,
      );
      // とらもようのパンツ
      const pants = new Graphics()
        .roundRect(-r * 0.55, r * 0.5, r * 1.1, r * 0.32, r * 0.12)
        .fill(ctx.colors.yellow)
        .stroke({ width: ctx.line * 0.8, color: ctx.colors.ink });
      for (const sx of [-0.3, 0, 0.3]) pants.rect(r * sx - r * 0.04, r * 0.52, r * 0.08, r * 0.28).fill(ctx.colors.ink);
      // もじゃもじゃの髪
      const hair = new Graphics();
      for (let i = -2; i <= 2; i++) hair.circle(i * r * 0.2, -r * 0.82 + Math.abs(i) * r * 0.08, r * 0.17).fill(ctx.colors.ink);
      const f = face(r * 1.3, "smile");
      f.y = -r * 0.05;
      // パンツは歯に見えて こわいので、体の外（下）に小さく出す
      pants.y = r * 0.42;
      c.addChild(horns, pants, body, hair, f);
      return { c, face: f };
    };

    const spawn = () => {
      if (onis.size >= params.count) return;
      const fromLeft = ctx.random() < 0.5;
      const x = r * 1.5 + ctx.random() * (width - r * 3);
      const y = top + ctx.random() * (bottom - top);
      // 区画（「小さい子の側は大きくゆっくり」など）に合わせ、鬼はその区画の中だけを歩く
      const z = ctx.zone(x, y);
      const rr = r * z.size;
      const area = ctx.zoneRect(x, y);
      const { c, face: f } = makeOni(colors[Math.floor(ctx.random() * colors.length)]!, rr);
      c.x = Math.min(Math.max(x, area.x0 + rr * 1.3), area.x1 - rr * 1.3);
      c.y = y;
      ctx.stage.addChild(c);
      void ctx.motion.popIn(c, 450);
      const oni: Oni = { c, face: f, r: rr, vx: (fromLeft ? 1 : -1) * unit * (5 + ctx.random() * 4) * params.speed * z.speed, stop: () => {} };
      const y0 = c.y;
      const phase = ctx.random() * Math.PI * 2;
      oni.stop = ctx.motion.loop((dt, time) => {
        if (c.destroyed) return false;
        c.x += (oni.vx * dt) / 1000;
        if (c.x < area.x0 + rr * 1.3) oni.vx = Math.abs(oni.vx);
        if (c.x > area.x1 - rr * 1.3) oni.vx = -Math.abs(oni.vx);
        // てくてく歩く
        c.y = y0 - Math.abs(Math.sin(time / 300 + phase)) * unit * 1.5;
        c.rotation = Math.sin(time / 300 + phase) * 0.06;
        return true;
      });
      onis.add(oni);
    };

    // ときどき まばたき
    ctx.every(900, () => {
      for (const o of onis) if (ctx.random() < 0.25) void ctx.motion.blink(o.face);
    });

    for (let i = 0; i < Math.min(3, params.count); i++) ctx.after(i * 500, spawn);
    ctx.every(1500, spawn);

    ctx.onHit((hit) => {
      let best: Oni | null = null;
      let bestD = Infinity;
      for (const o of onis) {
        const d = Math.hypot(hit.x - o.c.x, hit.y - o.c.y);
        if (d < bestD && ctx.near(hit, o.c, o.r * 1.2)) {
          best = o;
          bestD = d;
        }
      }
      if (!best) {
        ctx.fx.ripple(hit.x, hit.y, { radius: 6 });
        ctx.sound.miss();
        return;
      }
      const o = best;
      onis.delete(o);
      o.stop();
      o.c.rotation = 0;
      // びっくり顔に変える
      const f2 = face(o.r * 1.3, "surprised");
      f2.position.copyFrom(o.face.position);
      o.face.destroy({ children: true });
      o.c.addChild(f2);
      ctx.sound.boing();
      ctx.fx.burst(o.c.x, o.c.y, { color: 0xf3d9a4, count: 14 }); // まめ
      ctx.fx.popText(o.c.x, o.c.y - o.r * 1.4, "おにはそと！");
      total++;
      if (params.showCount) ctx.setScore(`みんなで ${total}`);
      if (total % 10 === 0) {
        ctx.sound.fanfare();
        ctx.fx.confetti(width);
        ctx.announce("ふくはうち！", 1800);
      }
      // ぴょんと跳ねて、近い方の はしへ にげていく
      void ctx.motion.hop(o.c, unit * 6, 400).then(async () => {
        if (o.c.destroyed) return;
        ctx.sound.whoosh();
        const toX = o.c.x < width / 2 ? -o.r * 3 : width + o.r * 3;
        await ctx.motion.to(o.c, { x: toX }, 700);
        if (!o.c.destroyed) o.c.destroy({ children: true });
      });
    });
  },
});
