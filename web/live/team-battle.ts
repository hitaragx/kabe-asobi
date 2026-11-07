import { Container, Graphics, Text } from "pixi.js";
import { balloon, sky } from "../engine/draw.ts";
import { defineGame } from "../engine/game.ts";

export default defineGame({
  id: "team-battle",
  title: "あか・あお ふうせん たいけつ",
  description:
    "左が あかチーム、右が あおチーム。自分のチームの側に のぼってくる風船に ボールを当てて わる。まん中の まるに 当てると はじまり、時間内に たくさん わった方の かち。終わると、また まるに 当てて はじめる。",
  rule: "チーム対戦",
  ages: "小学生",
  input: "ボール",
  music: "nigiyaka",
  params: {
    size: { value: 1, label: "風船の大きさ", min: 0.5, max: 2 },
    speed: { value: 1, label: "のぼる速さ", min: 0.3, max: 2 },
    count: { value: 4, label: "片側に いちどに出る数", min: 1, max: 10 },
    seconds: { value: 90, label: "1回の時間（秒）", min: 30, max: 120 },
  },

  setup(ctx) {
    const { unit, width, height, params } = ctx;
    const r = unit * 7 * params.size;
    const mid = width / 2;

    const bg = sky(width, height, ctx.line);
    ctx.stage.addChild(bg);
    for (const cl of bg.children) if (cl.label === "cloud") ctx.motion.drift(cl, unit * (1 + ctx.random()), 0);

    // 左右の色うすく ＋ まん中の線
    const tint = new Graphics()
      .rect(0, 0, mid, height)
      .fill({ color: ctx.colors.red, alpha: 0.12 })
      .rect(mid, 0, mid, height)
      .fill({ color: ctx.colors.blue, alpha: 0.12 });
    const divider = new Graphics()
      .rect(mid - unit * 0.6, 0, unit * 1.2, height)
      .fill(ctx.colors.white)
      .stroke({ width: ctx.line, color: ctx.colors.ink });
    ctx.stage.addChild(tint, divider);

    // チームの点数（左右の上に大きく）
    const makeLabel = (name: string, color: number, x: number) => {
      const t = new Text({
        text: `${name} 0`,
        style: {
          fontFamily: "sans-serif",
          fontSize: unit * 8,
          fontWeight: "900",
          fill: color,
          stroke: { color: ctx.colors.white, width: unit * 1.2 },
        },
      });
      t.anchor.set(0.5, 0);
      t.x = x;
      // まん中の上には「のこり ○びょう」が出るので、その下に置く（4:3 など横が狭い画面でも重ならないように）
      t.y = unit * 13;
      ctx.stage.addChild(t);
      return t;
    };
    const teams = [
      { name: "あか", color: ctx.colors.red, x0: 0, x1: mid, score: 0, label: makeLabel("あか", ctx.colors.red, mid / 2) },
      { name: "あお", color: ctx.colors.blue, x0: mid, x1: width, score: 0, label: makeLabel("あお", ctx.colors.blue, mid * 1.5) },
    ];

    type B = { c: Container; r: number; team: (typeof teams)[number] };
    const balloons = new Set<B>();
    let playing = false;
    let left = Math.round(params.seconds);

    const spawn = (team: (typeof teams)[number]) => {
      if (!playing) return;
      let n = 0;
      for (const b of balloons) if (b.team === team) n++;
      if (n >= params.count) return;
      const pad = r * 1.4 + unit;
      const x = team.x0 + pad + ctx.random() * Math.max(0, team.x1 - team.x0 - pad * 2);
      const z = ctx.zone(x, height * 0.5);
      const rr = r * z.size;
      const c = balloon(rr, team.color, ctx.line);
      c.x = x;
      c.y = height + rr * 1.5;
      ctx.stage.addChild(c);
      const b: B = { c, r: rr, team };
      balloons.add(b);
      ctx.motion.wobble(c, 0.12, 1800 + ctx.random() * 800);
      ctx.motion.drift(c, 0, -unit * (9 + ctx.random() * 5) * params.speed * z.speed, {
        width,
        height,
        margin: rr * 4,
        onExit: () => {
          balloons.delete(b);
          c.destroy({ children: true });
        },
      });
    };

    // まばたき
    ctx.every(900, () => {
      for (const b of balloons) if (ctx.random() < 0.2) {
        const f = b.c.getChildByLabel("face");
        if (f) void ctx.motion.blink(f as Container);
      }
    });

    // はじまり：まん中の的に当てたら、よーい、スタート！（誰もいないときは始まらない）
    ctx.setScore(null);
    ctx.waitStart(() => {
      ctx.announce("よーい…", 1200);
      ctx.after(1400, () => {
        ctx.announce("スタート！", 900);
        ctx.sound.whoosh();
        playing = true;
        ctx.setScore(`のこり ${left}びょう`);
        for (const t of teams) for (let i = 0; i < Math.min(3, params.count); i++) ctx.after(i * 400, () => spawn(t));
      });
    });
    ctx.every(800 / params.speed, () => {
      for (const t of teams) spawn(t);
    });

    ctx.every(1000, () => {
      if (!playing) return;
      left--;
      ctx.setScore(`のこり ${left}びょう`);
      if (left <= 3 && left > 0) ctx.sound.ding(left);
      if (left > 0) return;
      // おわり
      playing = false;
      ctx.setScore(null);
      const [a, b] = teams as [(typeof teams)[number], (typeof teams)[number]];
      ctx.sound.fanfare();
      ctx.fx.confetti(width);
      if (a.score === b.score) ctx.announce("ひきわけ！ どっちも すごい！", 5000);
      else ctx.announce(`${a.score > b.score ? a.name : b.name}チームの かち！`, 5000);
      ctx.finish(7000);
    });

    ctx.onHit((hit) => {
      if (!playing) return;
      let best: B | null = null;
      let bestD = Infinity;
      for (const b of balloons) {
        const d = Math.hypot(hit.x - b.c.x, hit.y - b.c.y);
        if (d < bestD && ctx.near(hit, b.c, b.r * 1.2)) {
          best = b;
          bestD = d;
        }
      }
      if (!best) {
        ctx.fx.ripple(hit.x, hit.y, { radius: 6 });
        ctx.sound.miss();
        return;
      }
      const b = best;
      balloons.delete(b);
      ctx.sound.pop();
      ctx.fx.burst(b.c.x, b.c.y, { color: b.team.color });
      ctx.fx.popText(b.c.x, b.c.y, "+1");
      b.c.destroy({ children: true });
      b.team.score++;
      b.team.label.text = `${b.team.name} ${b.team.score}`;
      void ctx.motion.squash(b.team.label);
    });
  },
});
