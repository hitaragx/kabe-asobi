import { defineGame } from "../engine/game.ts";
import { balloon, sky } from "../engine/draw.ts";
import type { Container } from "pixi.js";

export default defineGame({
  id: "balloons",
  title: "ふうせんわり",
  description: "下から ふわふわ のぼってくる風船に、ボールを当てて わる。勝ち負けはなく、いつ入っても遊べる。",
  rule: "的当て",
  ages: "3歳〜",
  input: "どちらでも",
  music: "nigiyaka",
  params: {
    size: { value: 1, label: "風船の大きさ", min: 0.5, max: 2 },
    speed: { value: 1, label: "のぼる速さ", min: 0.3, max: 2 },
    count: { value: 6, label: "いちどに出る数", min: 1, max: 15 },
    showCount: { value: true, label: "われた数を出す" },
  },

  setup(ctx) {
    const { unit, width, height, params } = ctx;
    const r = unit * 7 * params.size;
    const balloons = new Set<Container>();
    // 風船ごとの大きさ（区画によって変わる）
    // WeakMap：消した風船は自動で忘れる（Map だと、長く動かすほど消した風船がたまり続ける）
    const radius = new WeakMap<Container, number>();
    let popped = 0;
    const bg = sky(width, height, ctx.line);
    ctx.stage.addChild(bg);
    for (const cl of bg.children) if (cl.label === "cloud") ctx.motion.drift(cl, unit * (1 + ctx.random()), 0);
    if (params.showCount) ctx.setScore("0");

    const spawn = () => {
      if (balloons.size >= params.count) return;
      const color = ctx.pick(ctx.brights);
      const x = r * 1.5 + ctx.random() * (width - r * 3);
      // 区画（「小さい子の側は大きくゆっくり」など）に合わせる
      const z = ctx.zone(x, height * 0.5);
      const rr = r * z.size;
      const b = balloon(rr, color, ctx.line);
      b.x = x;
      b.y = height + rr * 1.5;
      radius.set(b, rr);
      ctx.stage.addChild(b);
      balloons.add(b);
      ctx.motion.wobble(b, 0.12, 1800 + ctx.random() * 800);
      ctx.motion.drift(b, 0, -unit * (8 + ctx.random() * 6) * params.speed * z.speed, {
        width,
        height,
        margin: rr * 4,
        onExit: () => {
          balloons.delete(b);
          b.destroy({ children: true });
        },
      });
      b.label = String(color); // はじけるときの色に使う
    };

    // まばたき
    ctx.every(900, () => {
      for (const b of balloons) if (ctx.random() < 0.2) {
        const f = b.getChildByLabel("face");
        if (f) void ctx.motion.blink(f as Container);
      }
    });

    for (let i = 0; i < Math.min(3, params.count); i++) ctx.after(i * 400, spawn);
    ctx.every(900 / params.speed, spawn);

    ctx.onHit((hit) => {
      // 一番近い風船を1つだけわる
      let best: Container | null = null;
      let bestD = Infinity;
      for (const b of balloons) {
        const d = Math.hypot(hit.x - b.x, hit.y - b.y);
        if (d < bestD && ctx.near(hit, b, (radius.get(b) ?? r) * 1.2)) {
          best = b;
          bestD = d;
        }
      }
      if (!best) {
        ctx.fx.ripple(hit.x, hit.y, { radius: 6 });
        return;
      }
      const b = best;
      balloons.delete(b);
      ctx.sound.pop();
      ctx.fx.burst(b.x, b.y, { color: Number(b.label) });
      ctx.fx.popText(b.x, b.y, "パン！");
      b.destroy({ children: true });
      popped++;
      if (params.showCount) ctx.setScore(String(popped));
      if (popped % 10 === 0) {
        ctx.sound.fanfare();
        ctx.fx.confetti(width);
      }
    });
  },
});
