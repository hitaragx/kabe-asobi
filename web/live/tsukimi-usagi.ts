import { Container, Graphics } from "pixi.js";
import { blobShape, face, sky } from "../engine/draw.ts";
import { defineGame } from "../engine/game.ts";

export default defineGame({
  id: "tsukimi-usagi",
  title: "おつきみ うさぎ",
  description: "大きな お月さまの したで、にこにこ顔の うさぎが ぴょんぴょん はねている。ボールを当てると 高く はねて おだんごが ぽん！と出る。勝ち負けはなく、みんなで当てた数を数える。",
  rule: "的当て",
  ages: "3歳〜",
  input: "ボール",
  music: "wa",
  params: {
    size: { value: 1, label: "うさぎの大きさ", min: 0.5, max: 2 },
    speed: { value: 1, label: "うさぎの動く速さ", min: 0, max: 2.5 },
    count: { value: 5, label: "いちどに出るうさぎの数", min: 1, max: 8 },
    /** うさぎがいる高さの範囲（0=上、1=下）。床すれすれには来ないようにする */
    top: { value: 0.3, label: "うさぎがいる高さ（上のはし）", min: 0.1, max: 0.6 },
    bottom: { value: 0.66, label: "うさぎがいる高さ（下のはし）", min: 0.3, max: 0.8 },
    showCount: { value: true, label: "みんなで当てた数を出す" },
  },

  setup(ctx) {
    const { unit, width, height, params } = ctx;
    const r = unit * 7 * params.size;
    const top = height * Math.min(params.top, params.bottom - 0.05) + r * 1.6;
    const bottom = Math.max(top, height * params.bottom);

    // 夕方の明るい空（暗くすると輪郭が見えないので、うすむらさき〜クリーム色）
    const bg = sky(width, height, ctx.line, 0xb7b4ff, 0xfff1d6, 2);
    ctx.stage.addChild(bg);
    for (const cl of bg.children) if (cl.label === "cloud") ctx.motion.drift(cl, unit * (0.8 + ctx.random()), 0);

    // 大きなお月さま（右上）
    const moonR = unit * 13;
    const moon = new Container();
    moon.addChild(
      new Graphics().circle(0, 0, moonR).fill(0xffe066).stroke({ width: ctx.line, color: ctx.colors.ink }),
      new Graphics().circle(-moonR * 0.35, -moonR * 0.2, moonR * 0.18).fill(0xf5cf45),
      new Graphics().circle(moonR * 0.3, moonR * 0.35, moonR * 0.12).fill(0xf5cf45),
    );
    const moonFace = face(moonR * 1.2, "sleepy");
    moonFace.alpha = 0.7;
    moon.addChild(moonFace);
    moon.x = width - moonR * 1.6;
    moon.y = moonR * 1.4;
    ctx.stage.addChild(moon);
    ctx.motion.float(moon);

    // すすき（左右のはし、下の方）
    const susuki = new Graphics();
    for (const [bx, h, lean] of [
      [unit * 4, unit * 30, 0.3],
      [unit * 8, unit * 24, 0.15],
      [width - unit * 5, unit * 28, -0.25],
      [width - unit * 9, unit * 22, -0.1],
    ] as const) {
      const tipX = bx + h * lean;
      const tipY = height - h;
      susuki.moveTo(bx, height).quadraticCurveTo(bx, height - h * 0.5, tipX, tipY).stroke({ width: ctx.line, color: 0x6a9a3a });
      susuki.ellipse(tipX, tipY + unit * 2, unit * 1.6, unit * 4).fill(0xf0d9a0).stroke({ width: ctx.line * 0.6, color: ctx.colors.ink });
    }
    ctx.stage.addChild(susuki);

    let total = 0;
    if (params.showCount) ctx.setScore("みんなで 0");

    type Usagi = { c: Container; face: Container; vx: number; r: number; stop: () => void };
    const usagis = new Set<Usagi>();
    const bodyColors = [ctx.colors.white, 0xffe3ec, 0xfff4c2, 0xdff1ff];

    const makeUsagi = (color: number, r: number): { c: Container; face: Container } => {
      const c = new Container();
      // 長い耳とまるいからだ・足（外側だけ太い輪郭）
      const body = blobShape(
        (g) => {
          g.ellipse(-r * 0.38, -r * 1.25, r * 0.22, r * 0.62);
          g.ellipse(r * 0.38, -r * 1.25, r * 0.22, r * 0.62);
          g.circle(0, 0, r);
          g.ellipse(-r * 0.5, r * 0.9, r * 0.32, r * 0.18);
          g.ellipse(r * 0.5, r * 0.9, r * 0.32, r * 0.18);
        },
        color,
        ctx.line,
      );
      // 耳の内側（ピンク）とほっぺ
      const inner = new Graphics()
        .ellipse(-r * 0.38, -r * 1.25, r * 0.1, r * 0.42)
        .fill(0xff9fbf)
        .ellipse(r * 0.38, -r * 1.25, r * 0.1, r * 0.42)
        .fill(0xff9fbf)
        .circle(-r * 0.55, r * 0.2, r * 0.13)
        .fill(0xffb3c8)
        .circle(r * 0.55, r * 0.2, r * 0.13)
        .fill(0xffb3c8);
      const f = face(r * 1.3, "smile");
      f.y = -r * 0.05;
      c.addChild(body, inner, f);
      return { c, face: f };
    };

    const spawn = () => {
      if (usagis.size >= params.count) return;
      const fromLeft = ctx.random() < 0.5;
      const x = r * 1.5 + ctx.random() * (width - r * 3);
      let y = top + ctx.random() * (bottom - top);
      // お月さまの近くでは、耳が月にかからない高さまで下げる
      if (x > moon.x - moonR * 2.2) y = Math.max(y, moon.y + moonR + r * 2.2);
      // 区画（「小さい子の側は大きくゆっくり」など）に合わせ、うさぎはその区画の中だけを動く
      const z = ctx.zone(x, y);
      const rr = r * z.size;
      const area = ctx.zoneRect(x, y);
      const { c, face: f } = makeUsagi(ctx.pick(bodyColors), rr);
      c.x = Math.min(Math.max(x, area.x0 + rr * 1.3), area.x1 - rr * 1.3);
      c.y = y;
      ctx.stage.addChild(c);
      void ctx.motion.popIn(c, 450);
      const u: Usagi = { c, face: f, r: rr, vx: (fromLeft ? 1 : -1) * unit * (4 + ctx.random() * 3) * params.speed * z.speed, stop: () => {} };
      const y0 = c.y;
      const phase = ctx.random() * Math.PI * 2;
      u.stop = ctx.motion.loop((dt, time) => {
        if (c.destroyed) return false;
        c.x += (u.vx * dt) / 1000;
        if (c.x < area.x0 + rr * 1.3) u.vx = Math.abs(u.vx);
        if (c.x > area.x1 - rr * 1.3) u.vx = -Math.abs(u.vx);
        // ぴょんぴょん はねる
        c.y = y0 - Math.abs(Math.sin(time / 380 + phase)) * unit * 3;
        c.scale.x = u.vx < 0 ? -1 : 1;
        return true;
      });
      usagis.add(u);
    };

    ctx.every(900, () => {
      for (const u of usagis) if (ctx.random() < 0.25) void ctx.motion.blink(u.face);
    });

    for (let i = 0; i < Math.min(3, params.count); i++) ctx.after(i * 500, spawn);
    ctx.every(1500, spawn);

    // おだんご（白・ピンク・みどり）がぽんと出る
    const dango = (x: number, y: number) => {
      const g = new Graphics();
      const dr = unit * 2.2;
      g.moveTo(0, dr * 1.8).lineTo(0, -dr * 3.6).stroke({ width: ctx.line * 0.8, color: 0xa86b32 });
      [0xffffff, 0xffa8c5, 0x9edc7a].forEach((col, i) => {
        g.circle(0, dr * 0.8 - i * dr * 1.7, dr).fill(col).stroke({ width: ctx.line * 0.7, color: ctx.colors.ink });
      });
      g.x = x;
      g.y = y;
      ctx.stage.addChild(g);
      void ctx.motion.popIn(g, 300);
      void ctx.motion.to(g, { y: y - unit * 10, alpha: 0 }, 1200).then(() => {
        if (!g.destroyed) g.destroy();
      });
    };

    ctx.onHit((hit) => {
      let best: Usagi | null = null;
      let bestD = Infinity;
      for (const u of usagis) {
        const d = Math.hypot(hit.x - u.c.x, hit.y - u.c.y);
        if (d < bestD && ctx.near(hit, u.c, u.r * 1.3)) {
          best = u;
          bestD = d;
        }
      }
      if (!best) {
        ctx.fx.ripple(hit.x, hit.y, { radius: 6 });
        ctx.sound.miss();
        return;
      }
      const u = best;
      usagis.delete(u);
      u.stop();
      const f2 = face(u.r * 1.3, "happy");
      f2.position.copyFrom(u.face.position);
      u.face.destroy({ children: true });
      u.c.addChild(f2);
      ctx.sound.boing();
      ctx.fx.burst(u.c.x, u.c.y, { color: 0xffe066, count: 14 });
      dango(u.c.x, u.c.y - u.r * 1.2);
      ctx.fx.popText(u.c.x, u.c.y - u.r * 3.2, "ぴょん！");
      total++;
      if (params.showCount) ctx.setScore(`みんなで ${total}`);
      if (total % 10 === 0) {
        ctx.sound.fanfare();
        ctx.fx.confetti(width);
        ctx.announce("おつきさま にっこり！", 1800);
      }
      // 高くはねて、お月さまの方へ ぴょーんと 帰っていく
      void ctx.motion.hop(u.c, unit * 10, 450).then(async () => {
        if (u.c.destroyed) return;
        ctx.sound.whoosh();
        await ctx.motion.to(u.c, { x: moon.x, y: moon.y, scale: 0.2, alpha: 0 }, 900);
        if (!u.c.destroyed) u.c.destroy({ children: true });
      });
    });
  },
});
