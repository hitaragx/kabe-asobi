import { Graphics } from "pixi.js";
import { type Character, CharacterMotion, makeCharacter } from "../engine/characters.ts";
import { sky } from "../engine/draw.ts";
import { defineGame } from "../engine/game.ts";

export default defineGame({
  id: "animal-band",
  title: "どうぶつ おんがくたい",
  description: "原っぱに ならんだ動物に当てると、ぴょんと跳ねて それぞれの音が鳴る。勝ち負けはなく、小さい子でも遊べる。",
  rule: "終わりのない遊び",
  ages: "2歳〜",
  input: "どちらでも",
  params: {
    animals: { value: 5, label: "動物の数", min: 2, max: 8 },
    size: { value: 1, label: "動物の大きさ", min: 0.5, max: 1.6 },
    /** 動物がいる高さ（0=上、1=下）。車いすの子や小さい子には下の方がよい */
    row: { value: 0.78, label: "動物がいる高さ", min: 0.3, max: 0.95 },
  },

  setup(ctx) {
    const { width, height, unit, params } = ctx;
    const cm = new CharacterMotion(ctx.motion);
    ctx.stage.addChild(sky(width, height, ctx.line, 0x6ec6ff, 0xd6f1ff, 3));
    const groundY = height * Math.min(0.97, params.row + 0.04);
    const ground = new Graphics()
      .roundRect(-ctx.line, groundY, width + ctx.line * 2, height - groundY + ctx.line, unit * 2)
      .fill(0x7ed957)
      .stroke({ width: ctx.line, color: ctx.colors.ink });
    ctx.stage.addChild(ground);

    const kinds = ["bear", "cat", "chick", "ghost"];
    const n = Math.round(params.animals);
    const size = Math.min((width / n) * 0.75, unit * 30) * params.size;
    const band: { ch: Character; note: number; busy: boolean }[] = [];
    for (let i = 0; i < n; i++) {
      const ch = makeCharacter(kinds[i % kinds.length]!, size, ctx.line);
      ch.x = ((i + 0.5) / n) * width;
      ch.y = groundY + size * 0.04; // 足元を地面に少しめり込ませる
      ctx.stage.addChild(ch);
      void ctx.motion.popIn(ch, 500 + i * 120);
      cm.idle(ch);
      band.push({ ch, note: i * 2, busy: false });
    }

    // ときどき誰かが手を振って「当ててね」と誘う
    ctx.every(4000, () => {
      const m = ctx.pick(band);
      if (!m.busy) void cm.wave(m.ch);
    });

    ctx.onHit((hit) => {
      // キャラクターの中心は足元から体の高さの半分ほど上
      const target = band.find((m) => ctx.near(hit, { x: m.ch.x, y: m.ch.y - size * 0.5 }, size * 0.6));
      if (!target) {
        ctx.fx.ripple(hit.x, hit.y, { radius: 6 });
        ctx.sound.miss();
        return;
      }
      ctx.sound.note(target.note);
      ctx.fx.burst(target.ch.x, target.ch.y - size, { count: 10, size: 0.8 });
      ctx.fx.popText(target.ch.x, target.ch.y - size * 1.2, "♪", { color: ctx.colors.white, size: 10 });
      if (target.busy) return;
      target.busy = true;
      void cm.joy(target.ch, size * 0.35).then(() => {
        target.busy = false;
      });
    });
  },
});
