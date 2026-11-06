import { Container, Graphics } from "pixi.js";
import { mix } from "../engine/draw.ts";
import { defineGame } from "../engine/game.ts";

export default defineGame({
  id: "sakana",
  title: "おさかな すいすい",
  description: "水の中を 魚が しっぽを ふりながら 泳いでいる。手で さわると、びっくりして くるっと 回り、にこにこ顔で すいっと 泳いでいく。勝ち負けはなく、ずっと遊べる。",
  rule: "終わりのない遊び",
  ages: "2歳〜",
  input: "タッチ",
  music: "fushigi",
  params: {
    size: { value: 1, label: "魚の大きさ", min: 0.5, max: 2 },
    speed: { value: 1, label: "魚の泳ぐ速さ", min: 0, max: 2.5 },
    count: { value: 6, label: "いちどに泳ぐ魚の数", min: 2, max: 12 },
    /** 小さい子の手が届く高さに置く（0=上、1=下） */
    top: { value: 0.35, label: "魚が泳ぐ高さ（上のはし）", min: 0.05, max: 0.7 },
    bottom: { value: 0.85, label: "魚が泳ぐ高さ（下のはし）", min: 0.4, max: 0.95 },
  },

  setup(ctx) {
    const { unit, width, height, params, line, colors } = ctx;
    const ink = colors.ink;
    const baseL = unit * 16 * params.size;
    const topY = height * Math.min(params.top, params.bottom - 0.1);
    const bottomY = height * params.bottom;

    // ---- 背景：水（上が明るく、下が深い青）、光の筋、砂、水草 ----
    const bg = new Graphics();
    const bands = 24;
    for (let i = 0; i < bands; i++) {
      bg.rect(0, (height * i) / bands, width, height / bands + 1).fill(mix(0x6fd3ff, 0x1f6fc9, i / (bands - 1)));
    }
    ctx.stage.addChild(bg);

    const rays = new Container();
    for (let i = 0; i < 4; i++) {
      const x = width * (0.12 + i * 0.25);
      const w = unit * (6 + i * 2);
      const r = new Graphics().poly([x - w * 0.4, 0, x + w * 0.4, 0, x + w * 2, height * 0.8, x - w * 0.2, height * 0.8]).fill({ color: colors.white, alpha: 0.07 });
      rays.addChild(r);
    }
    ctx.stage.addChild(rays);
    ctx.motion.loop((_dt, t) => {
      rays.children.forEach((r, i) => (r.alpha = 0.7 + Math.sin(t / 1800 + i * 1.7) * 0.3));
    });

    const sandTop = height * 0.93;
    const sand = new Graphics();
    sand.rect(0, sandTop, width, height - sandTop).fill(0xf3d98b);
    sand.moveTo(0, sandTop).lineTo(width, sandTop).stroke({ width: line, color: ink });
    for (let i = 0; i < 9; i++) {
      sand.ellipse(width * (0.05 + i * 0.11), sandTop + (height - sandTop) * 0.55, unit * 1.2, unit * 0.7).fill(0xe0bb63);
    }

    // 水草（根もとを中心に ゆらゆら）
    const weeds = new Container();
    const weedColors = [0x4cc66a, 0x2fae5a, 0x7ad35c];
    for (let i = 0; i < 7; i++) {
      const h = height * (0.18 + ctx.random() * 0.14);
      const w = unit * 3;
      const g = new Graphics();
      const curve = (gg: Graphics) =>
        gg.moveTo(0, 0).quadraticCurveTo(-w, -h * 0.33, 0, -h * 0.5).quadraticCurveTo(w, -h * 0.75, 0, -h);
      curve(g).stroke({ width: unit * 2.6 + line * 2, color: ink, cap: "round" });
      curve(g).stroke({ width: unit * 2.6, color: weedColors[i % 3]!, cap: "round" });
      g.x = width * (0.04 + i * 0.155 + ctx.random() * 0.03);
      g.y = sandTop + line;
      weeds.addChild(g);
      ctx.motion.wobble(g, 0.12, 2600 + ctx.random() * 1200);
    }
    ctx.stage.addChild(weeds, sand);

    // 飾りの小さな泡（下から上へ のぼる）
    const deco = new Container();
    ctx.stage.addChild(deco);
    ctx.every(450, () => {
      const r = unit * (0.6 + ctx.random() * 0.9);
      const b = new Graphics().circle(0, 0, r).stroke({ width: Math.max(1, line * 0.4), color: colors.white, alpha: 0.8 });
      b.circle(-r * 0.35, -r * 0.35, r * 0.25).fill({ color: colors.white, alpha: 0.9 });
      b.x = ctx.random() * width;
      b.y = sandTop;
      deco.addChild(b);
      ctx.motion.drift(b, 0, -unit * (6 + ctx.random() * 6), { width, height, margin: unit * 3, onExit: () => b.destroy() });
      ctx.motion.wobble(b, 0.3, 900);
    });

    // ---- 魚（体・しっぽ・せびれ・むなびれ・目を別の部品にして、しっぽを ふる） ----
    type Fish = {
      c: Container;
      body: Container;
      tail: Graphics;
      fin: Graphics;
      eye: Container;
      L: number;
      vx: number;
      baseY: number;
      phase: number;
      color: number;
      state: "swim" | "surprised" | "dash";
    };
    const fishes = new Set<Fish>();
    const fishColors = [colors.orange, colors.yellow, colors.pink, colors.red, colors.purple, colors.green];

    const drawEye = (eye: Container, L: number, mood: "smile" | "surprised" | "happy") => {
      eye.removeChildren().forEach((ch) => ch.destroy());
      const g = new Graphics();
      const r = L * 0.075;
      if (mood === "happy") {
        g.arc(0, r * 0.4, r, Math.PI, 0).stroke({ width: L * 0.035, color: ink, cap: "round" });
      } else {
        const rr = mood === "surprised" ? r * 1.35 : r;
        g.circle(0, 0, rr).fill(ink);
        g.circle(rr * 0.35, -rr * 0.4, rr * 0.38).fill(colors.white);
      }
      // 口
      const mx = L * 0.15;
      const my = L * 0.08;
      if (mood === "surprised") g.ellipse(mx, my + L * 0.02, L * 0.04, L * 0.05).fill(ink);
      else g.arc(mx, my - L * 0.03, L * 0.065, 0.05 * Math.PI, 0.8 * Math.PI).stroke({ width: L * 0.035, color: ink, cap: "round" });
      // ほっぺ
      g.ellipse(L * 0.02, L * 0.12, L * 0.05, L * 0.03).fill({ color: colors.pink, alpha: 0.8 });
      eye.addChild(g);
    };

    const makeFish = (L: number, color: number) => {
      const c = new Container();
      const body = new Container();
      const light = mix(color, colors.white, 0.45);
      const sw = line;

      // せびれ（体の後ろに描く）
      const fin = new Graphics()
        .poly([-L * 0.18, -L * 0.22, L * 0.1, -L * 0.27, -L * 0.25, -L * 0.48])
        .fill(light)
        .stroke({ width: sw, color: ink, join: "round" });
      // しっぽ（付け根を回る中心にする）
      const tail = new Graphics()
        .poly([0, 0, -L * 0.32, -L * 0.28, -L * 0.24, 0, -L * 0.32, L * 0.28])
        .fill(color)
        .stroke({ width: sw, color: ink, join: "round" });
      tail.x = -L * 0.42;
      // 体
      const torso = new Graphics();
      torso.ellipse(0, 0, L * 0.5, L * 0.3).fill(color).stroke({ width: sw, color: ink });
      torso.ellipse(L * 0.02, L * 0.12, L * 0.3, L * 0.1).fill({ color: colors.white, alpha: 0.45 });
      // しま模様
      torso.moveTo(-L * 0.12, -L * 0.27).quadraticCurveTo(-L * 0.2, 0, -L * 0.12, L * 0.27).stroke({ width: sw * 1.6, color: light });
      // むなびれ
      // むなびれ（付け根から後ろへ のびる小さな ひれ）
      const pec = new Graphics()
        .poly([0, 0, -L * 0.17, -L * 0.07, -L * 0.13, L * 0.07])
        .fill(mix(color, ink, 0.25));
      pec.x = L * 0.08;
      pec.y = L * 0.1;
      const eye = new Container();
      eye.x = L * 0.24;
      eye.y = -L * 0.06;
      drawEye(eye, L, "smile");

      body.addChild(fin, tail, torso, pec, eye);
      c.addChild(body);
      return { c, body, tail, fin, pec, eye };
    };

    /** inside：最初の魚は画面の中に出す。あとの魚は画面の外から泳いで入ってくる */
    const spawn = (inside = false) => {
      if (fishes.size >= params.count) return;
      const fromLeft = ctx.random() < 0.5;
      const y = topY + ctx.random() * Math.max(1, bottomY - topY);
      const z = ctx.zone(fromLeft ? 0 : width, y);
      const L = baseL * z.size * (0.8 + ctx.random() * 0.4);
      const color = ctx.pick(fishColors);
      const parts = makeFish(L, color);
      const area = ctx.zoneRect(width / 2, y);
      const baseY = Math.min(Math.max(y, Math.max(area.y0, topY) + L * 0.4), Math.min(area.y1, bottomY) - L * 0.4);
      parts.c.x = inside ? L * 1.5 + ctx.random() * (width - L * 3) : fromLeft ? -L : width + L;
      parts.c.y = baseY;
      ctx.stage.addChildAt(parts.c, ctx.stage.getChildIndex(deco));
      if (inside) void ctx.motion.popIn(parts.c, 500);
      const sp = unit * (6 + ctx.random() * 5) * params.speed * z.speed;
      const f: Fish = { ...parts, L, vx: fromLeft ? sp : -sp, baseY, phase: ctx.random() * Math.PI * 2, color, state: "swim" };
      fishes.add(f);

      let turnCooldown = 0;
      ctx.motion.loop((dt, time) => {
        if (f.c.destroyed) return false;
        const dir = Math.sign(f.vx) || 1;
        const fast = f.state === "dash" ? 3 : 1;
        // しっぽ・ひれを ふる（速く泳ぐほど 速く ふる）
        const beat = (time / (420 / fast)) * Math.PI * 2 + f.phase;
        f.tail.rotation = Math.sin(beat) * 0.45;
        f.fin.rotation = Math.sin(beat - 1) * 0.06;
        parts.pec.rotation = Math.sin(beat * 0.8) * 0.5;
        // 体も少し くねらせる
        f.body.scale.set(dir * (1 + Math.sin(beat) * 0.03), 1 - Math.sin(beat) * 0.03);
        if (f.state === "surprised") return true;

        f.c.x += (f.vx * fast * dt) / 1000;
        const wave = Math.sin(time / 900 + f.phase);
        f.c.y = f.baseY + wave * unit * 2.5;
        f.c.rotation = Math.cos(time / 900 + f.phase) * 0.12 * dir;

        if (f.state === "dash") {
          if (f.c.x < -f.L * 1.5 || f.c.x > width + f.L * 1.5) {
            fishes.delete(f);
            f.c.destroy({ children: true });
            return false;
          }
          return true;
        }
        // 画面の中に入ったら、はしで向きを変える。ときどき気まぐれに向きを変える
        turnCooldown -= dt;
        const inside = f.c.x > f.L && f.c.x < width - f.L;
        const atEdge = (f.c.x < f.L * 0.7 && f.vx < 0) || (f.c.x > width - f.L * 0.7 && f.vx > 0);
        if (atEdge || (inside && turnCooldown <= 0 && ctx.random() < dt / 9000)) {
          f.vx = -f.vx;
          turnCooldown = 2500;
        }
        return true;
      });
    };

    // 魚どうしが重ならないよう、近づいたら 上下に そっと よける
    ctx.motion.loop((dt) => {
      const list = [...fishes].filter((f) => f.state === "swim");
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]!;
          const b = list[j]!;
          const reachX = (a.L + b.L) * 0.55;
          const reachY = (a.L + b.L) * 0.4;
          if (Math.abs(a.c.x - b.c.x) > reachX || Math.abs(a.baseY - b.baseY) > reachY) continue;
          const push = (unit * 12 * dt) / 1000;
          const up = a.baseY <= b.baseY ? a : b;
          const down = up === a ? b : a;
          up.baseY = Math.max(topY + up.L * 0.4, up.baseY - push);
          down.baseY = Math.min(bottomY - down.L * 0.4, down.baseY + push);
        }
      }
    });

    for (let i = 0; i < params.count; i++) ctx.after(i * 150, () => spawn(true));
    ctx.every(1200, () => spawn());

    let noteIndex = 0;
    ctx.onHit((hit) => {
      let best: Fish | null = null;
      let bestD = Infinity;
      for (const f of fishes) {
        if (f.state !== "swim") continue;
        const d = Math.hypot(hit.x - f.c.x, hit.y - f.c.y);
        if (d < bestD && ctx.near(hit, f.c, f.L * 0.6)) {
          best = f;
          bestD = d;
        }
      }
      ctx.fx.ripple(hit.x, hit.y, { radius: 6, color: colors.white });
      if (!best) return;
      const f = best;
      f.state = "surprised";
      drawEye(f.eye, f.L, "surprised");
      ctx.sound.boing();
      ctx.sound.note(noteIndex++ % 8);
      ctx.fx.burst(f.c.x, f.c.y, { colors: [colors.white, 0xbfe9ff, f.color], count: 12, size: 0.8 });
      ctx.fx.popText(f.c.x, f.c.y - f.L * 0.5, "びっくり！");
      // くるっと回ってから、さわった手と反対の向きへ すいっと泳いでいく
      void ctx.motion.to(f.c, { rotation: f.c.rotation + Math.PI * 2 * (Math.sign(f.vx) || 1) }, 550).then(() => {
        if (f.c.destroyed) return;
        f.c.rotation = 0;
        const away = f.c.x >= hit.x ? 1 : -1;
        f.vx = Math.abs(f.vx || unit * 8) * away;
        f.state = "dash";
        drawEye(f.eye, f.L, "happy");
        ctx.sound.whoosh();
      });
    });
  },
});
