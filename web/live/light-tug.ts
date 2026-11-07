import { Container, Graphics, Text } from "pixi.js";
import { sky } from "../engine/draw.ts";
import { defineGame } from "../engine/game.ts";

const GOLD = 0xffc83d;

/** 光の的（原点は真ん中）：まわりがぼんやり光る、色の輪と白い芯 */
function lightTarget(r: number, color: number, line: number, ink: number): Container {
  const c = new Container();
  const glow = new Graphics()
    .circle(0, 0, r * 1.6).fill({ color, alpha: 0.18 })
    .circle(0, 0, r * 1.3).fill({ color, alpha: 0.28 });
  glow.label = "glow";
  const ring = new Graphics().circle(0, 0, r).fill(color).stroke({ width: line, color: ink });
  const mid = new Graphics().circle(0, 0, r * 0.62).fill(0xffffff).stroke({ width: line * 0.7, color: ink });
  const core = new Graphics().circle(0, 0, r * 0.28).fill(color);
  c.addChild(glow, ring, mid, core);
  return c;
}

export default defineGame({
  id: "light-tug",
  title: "ひかりの つなひき たいせん",
  description:
    "左が あかチーム、右が あおチーム。自分の陣地の中を動く光の的にボールを当てると点が入り、まんなかの光の線が相手側へ動く。相手の端まで押しこんだ方のかち。金の的は5点。終わるとまた最初から。",
  rule: "チーム対戦",
  ages: "中学生",
  input: "ボール",
  music: "nigiyaka",
  params: {
    size: { value: 1, label: "的の大きさ", min: 0.5, max: 2 },
    speed: { value: 1, label: "的の速さ", min: 0.3, max: 2 },
    count: { value: 3, label: "片側に いちどに出る数", min: 1, max: 8 },
    push: { value: 20, label: "押しきるのに要る点の差", min: 5, max: 60 },
    goldChance: { value: 0.1, label: "金の的が出る割合", min: 0, max: 0.4 },
  },

  setup(ctx) {
    const { unit, width, height, params } = ctx;
    const ink = ctx.colors.ink;
    const r = unit * 5 * params.size;
    const mid = width / 2;
    const top = unit * 16; // 点数の下から
    const bottom = height * 0.88; // 床すれすれには出さない
    const margin = r * 3.5; // 押されても、少しは陣地が残る
    let pos = 0; // -1（あおの勝ち）〜 +1（あかの勝ち）
    let lineX = mid;
    let shownX = mid;

    const bg = sky(width, height, ctx.line);
    ctx.stage.addChild(bg);
    for (const cl of bg.children) if (cl.label === "cloud") ctx.motion.drift(cl, unit * (1 + ctx.random()), 0);

    // 陣地の色
    const tint = new Graphics();
    const drawTint = () => {
      tint.clear()
        .rect(0, 0, shownX, height).fill({ color: ctx.colors.red, alpha: 0.22 })
        .rect(shownX, 0, width - shownX, height).fill({ color: ctx.colors.blue, alpha: 0.22 });
    };
    // まんなかの光の線
    const beam = new Graphics()
      .rect(-unit * 2.4, 0, unit * 4.8, height).fill({ color: 0xffffff, alpha: 0.35 })
      .rect(-unit * 1.2, 0, unit * 2.4, height).fill({ color: 0xffffff, alpha: 0.6 })
      .rect(-unit * 0.5, 0, unit * 1, height).fill(0xffffff).stroke({ width: ctx.line * 0.6, color: ink });
    const targetsLayer = new Container();
    ctx.stage.addChild(tint, targetsLayer, beam);
    beam.x = mid;
    ctx.motion.loop(() => {
      beam.alpha = 0.8 + 0.2 * Math.sin(performance.now() / 180);
    });

    const makeLabel = (name: string, color: number, x: number) => {
      const t = new Text({
        text: `${name} 0`,
        style: { fontFamily: "sans-serif", fontSize: unit * 8, fontWeight: "900", fill: color, stroke: { color: 0xffffff, width: unit * 1.5 } },
      });
      t.anchor.set(0.5, 0);
      t.x = x;
      t.y = unit * 2;
      ctx.stage.addChild(t);
      return t;
    };
    type Team = { name: string; color: number; dir: 1 | -1; score: number; label: Text };
    const red: Team = { name: "あか", color: ctx.colors.red, dir: 1, score: 0, label: makeLabel("あか", ctx.colors.red, width * 0.25) };
    const blue: Team = { name: "あお", color: ctx.colors.blue, dir: -1, score: 0, label: makeLabel("あお", ctx.colors.blue, width * 0.75) };
    const teams = [red, blue];

    /** そのチームの陣地（左右の端） */
    const area = (t: Team): [number, number] => (t === red ? [0, lineX] : [lineX, width]);

    type T = { c: Container; r: number; team: Team; vx: number; vy: number; gold: boolean };
    const targets = new Set<T>();
    let playing = false;

    const removeTarget = (t: T) => {
      targets.delete(t);
      void ctx.motion.popOut(t.c).then(() => t.c.destroy({ children: true }));
    };

    const spawn = (team: Team) => {
      if (!playing) return;
      let n = 0;
      for (const t of targets) if (t.team === team) n++;
      if (n >= params.count) return;
      const [x0, x1] = area(team);
      const x = x0 + r * 1.5 + ctx.random() * Math.max(0, x1 - x0 - r * 3);
      const y = top + r + ctx.random() * Math.max(0, bottom - top - r * 2);
      const z = ctx.zone(x, y);
      const gold = ctx.random() < params.goldChance;
      const rr = r * z.size * (gold ? 0.8 : 1);
      const c = lightTarget(rr, gold ? GOLD : team.color, ctx.line, ink);
      c.x = x;
      c.y = y;
      targetsLayer.addChild(c);
      void ctx.motion.popIn(c);
      const sp = unit * (18 + ctx.random() * 10) * params.speed * z.speed * (gold ? 1.6 : 1);
      const a = ctx.random() * Math.PI * 2;
      const t: T = { c, r: rr, team, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, gold };
      targets.add(t);
      if (gold) ctx.after(4500, () => { if (targets.has(t)) removeTarget(t); });
    };

    const setLine = () => {
      lineX = mid + pos * (mid - margin);
    };

    // はじまり
    ctx.setScore(null);
    drawTint();
    // 壁のどこかに当てたら始まる（誰もいないのに勝負が繰り返されないように）
    ctx.waitStart(() => {
      ctx.announce("よーい…", 1200);
      ctx.after(1400, () => {
        ctx.announce("スタート！", 900);
        ctx.sound.whoosh();
        playing = true;
        for (const t of teams) for (let i = 0; i < params.count; i++) ctx.after(i * 400, () => spawn(t));
      });
    });
    ctx.every(700 / params.speed, () => { for (const t of teams) spawn(t); });

    const win = (t: Team) => {
      playing = false;
      for (const o of [...targets]) removeTarget(o);
      ctx.sound.fanfare();
      ctx.fx.confetti(width);
      ctx.after(700, () => ctx.fx.confetti(width));
      ctx.announce(`${t.name}チームの かち！`, 5000);
      ctx.finish(7000);
    };

    ctx.onHit((hit) => {
      if (!playing) return;
      // 当たった場所の陣地のチームの的だけをねらえる
      const team = hit.x < lineX ? red : blue;
      let best: T | null = null;
      let bestD = Infinity;
      for (const t of targets) {
        if (t.team !== team) continue;
        const d = Math.hypot(hit.x - t.c.x, hit.y - t.c.y);
        if (d < bestD && ctx.near(hit, t.c, t.r * 1.15)) { best = t; bestD = d; }
      }
      if (!best) {
        ctx.fx.ripple(hit.x, hit.y, { radius: 6 });
        ctx.sound.miss();
        return;
      }
      const t = best;
      targets.delete(t);
      const pts = t.gold ? 5 : 1;
      ctx.sound.pop();
      if (t.gold) ctx.sound.fanfare();
      else ctx.sound.ding(team === red ? 3 : 5);
      ctx.fx.burst(t.c.x, t.c.y, { color: t.gold ? GOLD : team.color, count: t.gold ? 26 : 14 });
      ctx.fx.popText(t.c.x, t.c.y - t.r, `+${pts}`);
      t.c.destroy({ children: true });
      team.score += pts;
      team.label.text = `${team.name} ${team.score}`;
      void ctx.motion.squash(team.label);
      pos = Math.max(-1, Math.min(1, pos + (team.dir * pts) / params.push));
      setLine();
      if (Math.abs(pos) >= 1) win(team);
    });

    return {
      update(dtMs) {
        // 線はなめらかに追いかける
        if (Math.abs(lineX - shownX) > 0.5) {
          shownX += (lineX - shownX) * Math.min(1, dtMs / 150);
          beam.x = shownX;
          drawTint();
        }
        const dt = dtMs / 1000;
        for (const t of targets) {
          const [x0, x1] = area(t.team);
          t.c.x += t.vx * dt;
          t.c.y += t.vy * dt;
          const lo = x0 + t.r * 1.2;
          const hi = x1 - t.r * 1.2;
          if (t.c.x < lo) { t.c.x = Math.min(lo, hi); t.vx = Math.abs(t.vx); }
          if (t.c.x > hi) { t.c.x = Math.max(lo, hi); t.vx = -Math.abs(t.vx); }
          if (t.c.y < top + t.r) { t.c.y = top + t.r; t.vy = Math.abs(t.vy); }
          if (t.c.y > bottom - t.r) { t.c.y = bottom - t.r; t.vy = -Math.abs(t.vy); }
        }
      },
    };
  },
});
