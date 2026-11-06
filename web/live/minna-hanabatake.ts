import { Container, Graphics } from "pixi.js";
import { blobShape, face, sky } from "../engine/draw.ts";
import { defineGame } from "../engine/game.ts";
import { ease } from "../engine/motion.ts";

export default defineGame({
  id: "minna-hanabatake",
  title: "みんなで おはなばたけ",
  description:
    "壁の下のほうに 大きな つぼみが 並んでいる。手で そっと さわると、にっこり顔の お花が ぽんっと 咲く。咲くたびに おひさまが 大きくなり、みんなで 全部 咲かせると おはなばたけが できて おいわい。つぼみは 座っていても 手が届く 低い位置にある。",
  rule: "みんなで協力",
  ages: "3歳〜",
  input: "タッチ",
  music: "nonbiri",
  params: {
    size: { value: 1.2, label: "お花の大きさ", min: 0.5, max: 2 },
    count: { value: 7, label: "お花の数", min: 3, max: 12 },
    /** つぼみがある高さの範囲（0=上、1=下）。車いすの子・座っている子の手が届く低めにする */
    top: { value: 0.55, label: "お花がある高さ（上のはし）", min: 0.2, max: 0.75 },
    bottom: { value: 0.78, label: "お花がある高さ（下のはし）", min: 0.4, max: 0.88 },
    /** 0 = 全部咲くまで しぼまない（急がなくていい） */
    bloomSec: { value: 0, label: "咲いている時間（秒・0はずっと）", min: 0, max: 120 },
    reach: { value: 1.5, label: "さわって咲く広さ", min: 1, max: 2.5 },
  },

  setup(ctx) {
    const { unit, width, height, params } = ctx;
    const n = Math.max(1, Math.round(params.count));
    const yTop = height * Math.min(params.top, params.bottom - 0.05);
    const yBottom = height * Math.max(params.bottom, params.top + 0.05);
    const ground = height * 0.92;

    // 明るい空と、下に草原
    const bg = sky(width, height, ctx.line, 0x8fd8ff, 0xeaf8ff, 3);
    ctx.stage.addChild(bg);
    for (const cl of bg.children) if (cl.label === "cloud") ctx.motion.drift(cl, unit * (0.6 + ctx.random()), 0);

    // おひさま：咲いた数に合わせて大きくなる（数字は出さない）
    const sun = new Container();
    const sunR = unit * 9;
    const rays = new Graphics();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      rays
        .moveTo(Math.cos(a) * sunR * 1.25, Math.sin(a) * sunR * 1.25)
        .lineTo(Math.cos(a) * sunR * 1.6, Math.sin(a) * sunR * 1.6)
        .stroke({ width: ctx.line * 1.4, color: ctx.colors.orange, cap: "round" });
    }
    const disk = new Graphics().circle(0, 0, sunR).fill(ctx.colors.yellow).stroke({ width: ctx.line, color: ctx.colors.ink });
    const sunFace = face(sunR * 1.3, "smile");
    sun.addChild(rays, disk, sunFace);
    sun.x = width - sunR * 2.2;
    sun.y = sunR * 2.2;
    sun.scale.set(0.7);
    ctx.stage.addChild(sun);
    ctx.motion.loop((dt) => {
      rays.rotation += dt * 0.0002;
    });

    const grass = new Graphics()
      .rect(0, ground, width, height - ground)
      .fill(0x8fd96b)
      .moveTo(0, ground)
      .lineTo(width, ground)
      .stroke({ width: ctx.line, color: ctx.colors.ink });
    const field = new Container();
    const heads = new Container();
    field.addChild(grass);
    ctx.stage.addChild(field, heads);

    const petalColors = [ctx.colors.red, ctx.colors.yellow, ctx.colors.orange, ctx.colors.purple, ctx.colors.blue, 0xff8fc8];

    type Flower = {
      head: Container;
      bud: Container;
      bloom: Container;
      x: number;
      y: number;
      r: number;
      open: boolean;
      closeAt: number;
      note: number;
    };
    const flowers: Flower[] = [];

    const makeBud = (r: number, color: number): Container => {
      const c = new Container();
      const tip = blobShape(
        (g) => {
          g.ellipse(0, -r * 0.2, r * 0.55, r * 0.7);
          g.ellipse(-r * 0.25, -r * 0.1, r * 0.35, r * 0.55);
          g.ellipse(r * 0.25, -r * 0.1, r * 0.35, r * 0.55);
        },
        color,
        ctx.line,
      );
      const calyx = blobShape((g) => g.ellipse(0, r * 0.4, r * 0.5, r * 0.25), 0x4cbf4c, ctx.line);
      const f = face(r * 0.6, "sleepy");
      f.y = -r * 0.15;
      c.addChild(tip, calyx, f);
      return c;
    };

    const makeBloom = (r: number, color: number): Container => {
      const c = new Container();
      const petals = blobShape(
        (g) => {
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
            g.circle(Math.cos(a) * r * 0.75, Math.sin(a) * r * 0.75, r * 0.5);
          }
        },
        color,
        ctx.line,
      );
      const center = new Graphics()
        .circle(0, 0, r * 0.55)
        .fill(ctx.colors.yellow === color ? ctx.colors.orange : ctx.colors.yellow)
        .stroke({ width: ctx.line, color: ctx.colors.ink });
      const f = face(r * 0.85, "happy");
      c.addChild(petals, center, f);
      return c;
    };

    for (let i = 0; i < n; i++) {
      const x = (width * (i + 0.5)) / n;
      // 交互に高さを変えて、となりと重ならないようにする
      const y = n === 1 ? (yTop + yBottom) / 2 : i % 2 === 0 ? yBottom : yTop;
      const z = ctx.zone(x, y);
      const r = Math.min(unit * 8 * params.size * z.size, (width / n) * 0.85, (ground - y) * 0.9 + unit * 4);
      const color = petalColors[i % petalColors.length]!;

      // くき と 葉っぱ（地面から花まで）
      const stemRoot = new Container();
      stemRoot.x = x;
      const stem = new Graphics()
        .moveTo(0, ground)
        .lineTo(0, y)
        .stroke({ width: ctx.line * 2.2, color: ctx.colors.ink, cap: "round" })
        .moveTo(0, ground)
        .lineTo(0, y)
        .stroke({ width: ctx.line * 1.0, color: 0x4cbf4c, cap: "round" });
      stemRoot.addChild(stem);
      field.addChild(stemRoot);

      const head = new Container();
      head.x = x;
      head.y = y;
      const bud = makeBud(r, color);
      const bloom = makeBloom(r, color);
      bloom.visible = false;
      bud.cacheAsTexture(true);
      bloom.cacheAsTexture(true);
      head.addChild(bud, bloom);
      heads.addChild(head);
      // つぼみは ゆらゆら（さわる場所だと分かるように）
      ctx.motion.wobble(bud);

      flowers.push({ head, bud, bloom, x, y, r, open: false, closeAt: 0, note: i % 8 });
    }
    field.cacheAsTexture(true);

    let now = 0;
    let done = false;
    const openCount = () => flowers.filter((f) => f.open).length;
    const updateSun = () => {
      const t = openCount() / flowers.length;
      void ctx.motion.to(sun, { scale: 0.7 + t * 0.6 }, 500, ease.outBack);
    };

    const open = (fl: Flower) => {
      fl.open = true;
      fl.closeAt = now + params.bloomSec * 1000;
      fl.bud.visible = false;
      fl.bloom.visible = true;
      fl.bloom.scale.set(0.2);
      void ctx.motion.to(fl.bloom, { scale: 1 }, 500, ease.outBack);
      ctx.sound.note(fl.note);
      ctx.fx.burst(fl.x, fl.y, { color: 0xffd6ec, count: 12 });
      updateSun();
      if (openCount() === flowers.length) celebrate();
    };

    const close = (fl: Flower) => {
      fl.open = false;
      updateSun();
      void ctx.motion.to(fl.bloom, { scale: 0.2 }, 400).then(() => {
        if (fl.bloom.destroyed || fl.open) return;
        fl.bloom.visible = false;
        fl.bud.visible = true;
        fl.bud.scale.set(0.6);
        void ctx.motion.to(fl.bud, { scale: 1 }, 350, ease.outBack);
      });
    };

    const celebrate = () => {
      done = true;
      ctx.sound.fanfare();
      ctx.fx.confetti(width, 120);
      ctx.announce("おはなばたけ できた！", 3500);
      void ctx.motion.hop(sun, unit * 4);
      flowers.forEach((fl, i) => ctx.after(i * 120, () => void ctx.motion.hop(fl.head, unit * 3)));
      // しばらく みんなで ながめてから、またつぼみに もどる
      ctx.after(9000, () => {
        flowers.forEach((fl, i) => ctx.after(i * 150, () => close(fl)));
        ctx.after(flowers.length * 150 + 800, () => {
          done = false;
        });
      });
    };

    ctx.onHit((hit) => {
      if (done) return;
      let best: Flower | null = null;
      let bestD = Infinity;
      for (const fl of flowers) {
        const d = Math.hypot(hit.x - fl.x, hit.y - fl.y);
        if (d < bestD && ctx.near(hit, fl, fl.r * params.reach)) {
          best = fl;
          bestD = d;
        }
      }
      if (!best) {
        ctx.fx.ripple(hit.x, hit.y, { radius: 6 });
        return;
      }
      if (!best.open) {
        open(best);
      } else {
        // 咲いている花は、さわると ぷるんと 揺れて また長く咲く
        best.closeAt = now + params.bloomSec * 1000;
        void ctx.motion.squash(best.bloom, 0.2, 300);
        ctx.sound.note(best.note + 2);
      }
    });

    return {
      update(dtMs: number) {
        // 急がなくていいように、咲いた花は 全部咲くまで しぼまない（bloomSec は 0 より大きいときだけ使う）
        now += dtMs;
        if (done || params.bloomSec <= 0) return;
        for (const fl of flowers) if (fl.open && now >= fl.closeAt) close(fl);
      },
    };
  },
});
