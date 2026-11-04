import { Container, Graphics, RenderTexture, Sprite } from "pixi.js";
import { CharacterMotion, makeCharacter } from "../engine/characters.ts";
import { sky } from "../engine/draw.ts";
import { defineGame } from "../engine/game.ts";

export default defineGame({
  id: "cloud-clear",
  title: "くもを はらそう",
  description: "壁いっぱいの くもに ボールを当てると、くもが はれて 下から どうぶつが出てくる。みんなで全部はらしたら おいわい。",
  rule: "みんなで協力",
  ages: "3歳〜",
  input: "どちらでも",
  params: {
    brush: { value: 1, label: "1回で はれる広さ", min: 0.5, max: 3 },
    cell: { value: 1, label: "くもの つぶの大きさ", min: 0.6, max: 2 },
    showPercent: { value: true, label: "はれた割合を出す" },
  },

  setup(ctx) {
    // 枠が後片付けしない物（画像の入れ物と消しゴム）は、destroy で片付ける
    const { width, height, unit, params } = ctx;
    const cm = new CharacterMotion(ctx.motion);

    // 下の絵：空・原っぱ・どうぶつ
    ctx.stage.addChild(sky(width, height, ctx.line, 0x4fb3ff, 0xc9f0ff, 2));
    const groundY = height * 0.8;
    ctx.stage.addChild(
      new Graphics().roundRect(-ctx.line, groundY, width + ctx.line * 2, height, unit * 2).fill(0x7ed957).stroke({ width: ctx.line, color: ctx.colors.ink }),
    );
    const animals = ["bear", "cat", "chick", "ghost", "bear"].map((k, i, arr) => {
      const ch = makeCharacter(k, unit * 22, ctx.line);
      ch.x = ((i + 0.5) / arr.length) * width;
      ch.y = groundY + unit;
      ctx.stage.addChild(ch);
      cm.idle(ch);
      return ch;
    });

    // くも：丸いつぶを敷きつめた絵を1枚にまとめ（重くならないように）、当たった所だけ消す
    const r = unit * 5 * params.cell;
    const cells: { x: number; y: number; on: boolean }[] = [];
    const dx = r * 1.5;
    const dy = r * 1.3;
    const fog = new Graphics();
    for (let row = 0, y = 0; y < height + r; row++, y += dy) {
      for (let x = row % 2 ? dx / 2 : 0; x < width + r; x += dx) {
        fog.circle(x, y, r).fill(0xe8ecf4 - Math.floor(ctx.random() * 3) * 0x0a0a0a);
        cells.push({ x, y, on: true });
      }
    }
    const tex = RenderTexture.create({ width, height });
    ctx.app.renderer.render({ container: fog, target: tex, clear: true, clearColor: [0, 0, 0, 0] });
    fog.destroy();
    const cover = new Sprite(tex);
    ctx.stage.addChild(cover);
    const puffs = new Container();
    ctx.stage.addChild(puffs);
    // 消しゴム：描いた所を透明にする（入れ物ごと描くと、重ね方の指定が効く）
    const eraser = new Graphics();
    eraser.blendMode = "erase";
    const eraserRoot = new Container();
    eraserRoot.addChild(eraser);

    const total = cells.length;
    let left = total;
    let done = false;
    const percent = () => Math.floor(((total - left) / total) * 100);
    if (params.showPercent) ctx.setScore("0%");

    ctx.onHit((hit) => {
      if (done) return;
      const brush = unit * 12 * params.brush;
      let cleared = 0;
      eraser.clear();
      for (const c of cells) {
        if (!c.on || Math.hypot(c.x - hit.x, c.y - hit.y) > brush) continue;
        c.on = false;
        cleared++;
        eraser.circle(c.x, c.y, r * 1.05).fill(0xffffff);
      }
      if (cleared > 0) {
        ctx.app.renderer.render({ container: eraserRoot, target: tex, clear: false });
        // 消える様子：白いけむりが数個ぽんと縮む（見た目だけ）
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const puff = new Graphics().circle(0, 0, r).fill(0xffffff);
          puff.x = hit.x + Math.cos(a) * brush * 0.5;
          puff.y = hit.y + Math.sin(a) * brush * 0.5;
          puffs.addChild(puff);
          void ctx.motion.to(puff, { scale: 0, alpha: 0 }, 350 + ctx.random() * 200).then(() => puff.destroy());
        }
      }
      if (cleared === 0) {
        ctx.fx.ripple(hit.x, hit.y, { radius: 6 });
        return;
      }
      left -= cleared;
      ctx.sound.whoosh();
      ctx.fx.burst(hit.x, hit.y, { colors: [0xffffff, ctx.colors.blue], count: 12 });
      if (params.showPercent) ctx.setScore(`${percent()}%`);

      // 近くのどうぶつが顔を出したら喜ぶ
      for (const a of animals) if (Math.abs(a.x - hit.x) < brush && hit.y > groundY - unit * 30) void cm.joy(a, unit * 6);

      if (left <= total * 0.03) {
        // ほぼ全部はれたら、残りも消しておいわい
        done = true;
        for (const c of cells) c.on = false;
        eraser.clear().rect(0, 0, width, height).fill(0xffffff);
        ctx.app.renderer.render({ container: eraserRoot, target: tex, clear: false });
        ctx.setScore("100%");
        ctx.sound.fanfare();
        ctx.fx.confetti(width, 120);
        ctx.announce("ぜんぶ はれた！", 3000);
        animals.forEach((a, i) => ctx.after(i * 150, () => void cm.joy(a, unit * 10)));
        ctx.finish(7000);
      }
    });

    return {
      destroy() {
        eraserRoot.destroy({ children: true });
        tex.destroy(true);
      },
    };
  },
});
