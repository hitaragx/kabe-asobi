import { Container, Graphics } from "pixi.js";
import { blobShape, face, sky } from "../engine/draw.ts";
import { defineGame } from "../engine/game.ts";
import { ease } from "../engine/motion.ts";

export default defineGame({
  id: "hana-saku",
  title: "さわって さかせよう おはなばたけ",
  description: "壁に お花の つぼみが 並んでいる。手で さわると、にっこり顔の お花が ぽんっと 咲く。しばらくすると また つぼみに もどる。勝ち負けはなく、いつでも 入って 遊べる。",
  rule: "終わりのない遊び",
  ages: "2歳〜",
  input: "タッチ",
  music: "nonbiri",
  params: {
    size: { value: 1, label: "お花の大きさ", min: 0.5, max: 2 },
    count: { value: 8, label: "お花の数", min: 3, max: 14 },
    /** つぼみがある高さの範囲（0=上、1=下）。小さい子の手が届く低めにする */
    top: { value: 0.45, label: "お花がある高さ（上のはし）", min: 0.1, max: 0.7 },
    bottom: { value: 0.72, label: "お花がある高さ（下のはし）", min: 0.3, max: 0.85 },
    bloomSec: { value: 6, label: "咲いている時間（秒）", min: 2, max: 30 },
  },

  setup(ctx) {
    const { unit, width, height, params } = ctx;
    const n = Math.max(1, Math.round(params.count));
    const yTop = height * Math.min(params.top, params.bottom - 0.05);
    const yBottom = height * Math.max(params.bottom, params.top + 0.05);
    const ground = height * 0.86;

    // 明るい空と、下に草原
    const bg = sky(width, height, ctx.line, 0x8fd8ff, 0xeaf8ff, 3);
    ctx.stage.addChild(bg);
    for (const cl of bg.children) if (cl.label === "cloud") ctx.motion.drift(cl, unit * (0.6 + ctx.random()), 0);
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
      root: Container;
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
      // がく（緑）と、先っぽに花の色がのぞく つぼみ
      // 花びらが重なった ふっくらした つぼみ（下を緑のがくが包む）
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

    const makeBloom = (r: number, color: number): { c: Container; face: Container } => {
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
      return { c, face: f };
    };

    for (let i = 0; i < n; i++) {
      const x = (width * (i + 0.5)) / n;
      // 交互に高さを変えて、となりと重ならないようにする
      const y = n === 1 ? (yTop + yBottom) / 2 : i % 2 === 0 ? yBottom : yTop;
      const z = ctx.zone(x, y);
      const r = Math.min(unit * 8 * params.size * z.size, (width / n) * 0.9);
      const color = petalColors[i % petalColors.length]!;

      const root = new Container();
      root.x = x;
      field.addChild(root);

      // くき と 葉っぱ（地面から花まで）
      const stem = new Graphics()
        .moveTo(0, ground)
        .lineTo(0, y)
        .stroke({ width: ctx.line * 2.2, color: ctx.colors.ink, cap: "round" })
        .moveTo(0, ground)
        .lineTo(0, y)
        .stroke({ width: ctx.line * 1.0, color: 0x4cbf4c, cap: "round" });
      const leafY = y + (ground - y) * 0.55;
      const leaf = blobShape(
        (g) => {
          g.ellipse(r * 0.45, leafY, r * 0.45, r * 0.2);
          g.ellipse(-r * 0.45, leafY + r * 0.35, r * 0.45, r * 0.2);
        },
        0x5fd35f,
        ctx.line,
      );
      root.addChild(stem, leaf);

      const head = new Container();
      head.x = x;
      head.y = y;
      const bud = makeBud(r, color);
      const { c: bloom } = makeBloom(r, color);
      bloom.visible = false;
      // つぼみ・花はそれぞれ1枚の絵にまとめて、描く手間を減らす（数が多くても動きが重くならないように）
      bud.cacheAsTexture(true);
      bloom.cacheAsTexture(true);
      head.addChild(bud, bloom);
      heads.addChild(head);

      flowers.push({ root, head, bud, bloom, x, y, r, open: false, closeAt: 0, note: i % 8 });
    }
    // 動かない草原・くき・葉っぱは1枚の絵にまとめて、描く手間を減らす
    field.cacheAsTexture(true);

    let now = 0;
    let bloomed = 0;

    const open = (fl: Flower) => {
      fl.open = true;
      fl.closeAt = now + params.bloomSec * 1000;
      fl.bud.visible = false;
      fl.bloom.visible = true;
      fl.bloom.scale.set(0.2);
      void ctx.motion.to(fl.bloom, { scale: 1 }, 500, ease.outBack);
      ctx.sound.note(fl.note);
      ctx.fx.burst(fl.x, fl.y, { color: 0xffd6ec, count: 12 });
      bloomed++;
      // みんなで たくさん咲かせたら、ときどき 紙ふぶき（数は出さない）
      if (bloomed % 15 === 0) {
        ctx.sound.fanfare();
        ctx.fx.confetti(width);
      }
    };

    const close = (fl: Flower) => {
      fl.open = false;
      void ctx.motion.to(fl.bloom, { scale: 0.2 }, 400).then(() => {
        if (fl.bloom.destroyed || fl.open) return;
        fl.bloom.visible = false;
        fl.bud.visible = true;
        fl.bud.scale.set(0.6);
        void ctx.motion.to(fl.bud, { scale: 1 }, 350, ease.outBack);
      });
    };

    ctx.onHit((hit) => {
      let best: Flower | null = null;
      let bestD = Infinity;
      for (const fl of flowers) {
        const d = Math.hypot(hit.x - fl.x, hit.y - fl.y);
        if (d < bestD && ctx.near(hit, fl, fl.r * 1.3)) {
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
        // 咲いている花は、さわると ぷるんと 揺れて もう少し咲いている
        best.closeAt = now + params.bloomSec * 1000;
        void ctx.motion.squash(best.bloom, 0.2, 300);
        ctx.sound.note(best.note + 2);
      }
    });

    return {
      update(dtMs: number) {
        now += dtMs;
        for (const fl of flowers) if (fl.open && now >= fl.closeAt) close(fl);
      },
    };
  },
});
