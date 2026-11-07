import { defineGame } from "../engine/game.ts";
import { blobShape, sky, star } from "../engine/draw.ts";
import { palette } from "../engine/style.ts";
import { Container, Graphics } from "pixi.js";

/** ボクシングのミット（原点は真ん中）。まんなかに白い的 */
function mitt(r: number, color: number, line: number): Container {
  const c = new Container();
  const body = blobShape(
    (g) => {
      g.ellipse(0, -r * 0.1, r * 0.85, r);
      g.ellipse(-r * 0.8, r * 0.05, r * 0.32, r * 0.5); // 親指
      g.roundRect(-r * 0.6, r * 0.7, r * 1.2, r * 0.5, r * 0.15); // 手首
    },
    color,
    line,
  );
  const cuff = new Graphics().rect(-r * 0.6, r * 0.88, r * 1.2, r * 0.12).fill({ color: palette.white, alpha: 0.8 });
  const ring = new Graphics().circle(0, -r * 0.1, r * 0.48).fill(palette.white).stroke({ width: line, color: palette.ink });
  const dot = new Graphics().circle(0, -r * 0.1, r * 0.2).fill(color).stroke({ width: line * 0.7, color: palette.ink });
  const shine = new Graphics().ellipse(-r * 0.45, -r * 0.65, r * 0.14, r * 0.26).fill({ color: palette.white, alpha: 0.55 });
  shine.rotation = 0.5;
  c.addChild(body, cuff, ring, dot, shine);
  return c;
}

const GOLD = 0xffc83d;

export default defineGame({
  id: "punch-mitt",
  title: "パンチで ミットあて",
  description: "壁のあちこちに出てくるボクシングのミットを、手でタッチしてパンチ。勝ち負けはなく、みんなのパンチの数を数える。ときどき金のミットが出る。",
  rule: "的当て",
  ages: "3歳〜",
  input: "タッチ",
  music: "nigiyaka",
  params: {
    size: { value: 1, label: "ミットの大きさ", min: 0.5, max: 2 },
    speed: { value: 1, label: "出たり消えたりの速さ", min: 0.3, max: 2 },
    count: { value: 4, label: "いちどに出る数", min: 1, max: 10 },
    goldChance: { value: 0.15, label: "金のミットが出る割合", min: 0, max: 0.5 },
    goal: { value: 100, label: "おわりのパンチ数", min: 10, max: 300 },
    showCount: { value: true, label: "パンチの数を出す" },
  },

  setup(ctx) {
    const { unit, width, height, params } = ctx;
    const r = unit * 9 * params.size;
    const mitts = new Set<Container>();
    const info = new WeakMap<Container, { r: number; gold: boolean; color: number }>();
    let punches = 0;

    const bg = sky(width, height, ctx.line);
    ctx.stage.addChild(bg);
    for (const cl of bg.children) if (cl.label === "cloud") ctx.motion.drift(cl, unit * (1 + ctx.random()), 0);
    let done = false;
    if (params.showCount) ctx.setScore(`みんなで 0 / ${params.goal}パンチ`);

    const remove = (m: Container) => {
      mitts.delete(m);
      void ctx.motion.popOut(m).then(() => m.destroy({ children: true }));
    };

    const spawn = () => {
      if (done || mitts.size >= params.count) return;
      // ほかのミットと重ならない場所を探す（上の点数の所はさける）
      for (let tries = 0; tries < 12; tries++) {
        const x = r * 1.3 + ctx.random() * (width - r * 2.6);
        const y = height * 0.2 + r + ctx.random() * Math.max(0, height * 0.75 - r * 2.2);
        const z = ctx.zone(x, y);
        const rr = r * z.size;
        let ok = true;
        for (const o of mitts) {
          const oi = info.get(o);
          if (Math.hypot(o.x - x, o.y - y) < (rr + (oi?.r ?? r)) * 1.1) { ok = false; break; }
        }
        if (!ok) continue;
        const gold = ctx.random() < params.goldChance;
        const color = gold ? GOLD : ctx.pick(ctx.brights.filter((c) => c !== GOLD));
        const m = mitt(rr, color, ctx.line);
        m.x = x;
        m.y = y;
        m.rotation = (ctx.random() - 0.5) * 0.5;
        info.set(m, { r: rr, gold, color });
        ctx.stage.addChild(m);
        mitts.add(m);
        void ctx.motion.popIn(m);
        ctx.motion.wobble(m, 0.08, 1400 + ctx.random() * 600);
        // しばらくしたら、ひっこむ
        ctx.after((5000 + ctx.random() * 3000) / (params.speed * z.speed), () => {
          if (mitts.has(m)) remove(m);
        });
        return;
      }
    };

    for (let i = 0; i < Math.min(3, params.count); i++) ctx.after(i * 500, spawn);
    ctx.every(1100 / params.speed, spawn);

    ctx.onHit((hit) => {
      if (done) return;
      let best: Container | null = null;
      let bestD = Infinity;
      for (const m of mitts) {
        const d = Math.hypot(hit.x - m.x, hit.y - m.y);
        if (d < bestD && ctx.near(hit, m, (info.get(m)?.r ?? r) * 1.1)) {
          best = m;
          bestD = d;
        }
      }
      if (!best) {
        ctx.fx.ripple(hit.x, hit.y, { radius: 6 });
        return;
      }
      const m = best;
      const mi = info.get(m)!;
      mitts.delete(m);
      punches++;
      ctx.sound.pop();
      ctx.sound.boing();
      void ctx.motion.squash(m);
      ctx.fx.burst(m.x, m.y, { color: mi.color, count: mi.gold ? 24 : 12 });
      // 星がとびだす
      for (let i = 0; i < 3; i++) {
        const s = star(unit * 2.2, ctx.pick(ctx.brights), ctx.line * 0.7);
        s.x = m.x;
        s.y = m.y;
        ctx.stage.addChild(s);
        const a = (i / 3) * Math.PI * 2 + ctx.random();
        void ctx.motion.to(s, { x: m.x + Math.cos(a) * mi.r * 1.6, y: m.y + Math.sin(a) * mi.r * 1.6, alpha: 0, rotation: 2 }, 600)
          .then(() => s.destroy());
      }
      if (mi.gold) {
        ctx.fx.popText(m.x, m.y - mi.r, "キラーン！");
        ctx.sound.fanfare();
        ctx.fx.confetti(width);
      } else {
        ctx.fx.popText(m.x, m.y - mi.r, "バシッ！");
      }
      ctx.after(200, () => remove(m));
      if (params.showCount) ctx.setScore(`みんなで ${punches} / ${params.goal}パンチ`);
      if (punches >= params.goal) {
        // ゴール：のこりのミットをひっこめて、お祝いしてから最初から
        done = true;
        for (const o of [...mitts]) remove(o);
        ctx.announce(`やったね！\nみんなで ${params.goal}パンチ！`, 3500);
        ctx.sound.fanfare();
        ctx.fx.confetti(width);
        ctx.after(800, () => ctx.fx.confetti(width));
        ctx.finish(5000);
      } else if (punches % 20 === 0) {
        ctx.announce(`みんなで ${punches}パンチ！`, 1500);
        if (!mi.gold) ctx.sound.fanfare();
      }
    });
  },
});
