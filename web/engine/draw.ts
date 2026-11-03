// 絵の部品（フラット・太い輪郭・簡単な表情）。Graphics で描くので素材ファイルは要らない。

import { Container, Graphics } from "pixi.js";
import { palette } from "./style.ts";

export type Mood = "smile" | "happy" | "surprised" | "sleepy";

/** 顔（目と口）。size は顔の幅の目安（ピクセル） */
export function face(size: number, mood: Mood = "smile", ink: number = palette.ink): Container {
  const c = new Container();
  const eyeY = -size * 0.08;
  const eyeX = size * 0.2;
  const eyeR = size * 0.075;
  const eyes = new Graphics();
  if (mood === "happy") {
    // にっこり目（∩）
    for (const sx of [-1, 1]) eyes.arc(sx * eyeX, eyeY + eyeR * 0.5, eyeR, Math.PI, 0).stroke({ width: size * 0.05, color: ink, cap: "round" });
  } else if (mood === "sleepy") {
    for (const sx of [-1, 1]) eyes.moveTo(sx * eyeX - eyeR, eyeY).lineTo(sx * eyeX + eyeR, eyeY).stroke({ width: size * 0.05, color: ink, cap: "round" });
  } else {
    for (const sx of [-1, 1]) {
      eyes.ellipse(sx * eyeX, eyeY, eyeR, eyeR * (mood === "surprised" ? 1.4 : 1.15)).fill(ink);
      eyes.circle(sx * eyeX + eyeR * 0.35, eyeY - eyeR * 0.4, eyeR * 0.35).fill(palette.white);
    }
  }
  eyes.label = "eyes";
  const mouth = new Graphics();
  if (mood === "surprised") mouth.ellipse(0, size * 0.15, size * 0.07, size * 0.09).fill(ink);
  else mouth.arc(0, size * 0.08, size * 0.13, 0.15 * Math.PI, 0.85 * Math.PI).stroke({ width: size * 0.05, color: ink, cap: "round" });
  mouth.label = "mouth";
  // ほっぺ
  const cheeks = new Graphics();
  for (const sx of [-1, 1]) cheeks.ellipse(sx * size * 0.33, size * 0.08, size * 0.07, size * 0.045).fill({ color: palette.pink, alpha: 0.7 });
  c.addChild(cheeks, eyes, mouth);
  return c;
}

/** 空の背景（上が濃く、下が明るい）。雲を数個浮かべる */
export function sky(width: number, height: number, line: number, top = 0x4fb3ff, bottom = 0xbfe9ff, clouds = 4): Container {
  const c = new Container();
  const bands = 32;
  const g = new Graphics();
  for (let i = 0; i < bands; i++) {
    g.rect(0, (height * i) / bands, width, height / bands + 1).fill(mix(top, bottom, i / (bands - 1)));
  }
  c.addChild(g);
  for (let i = 0; i < clouds; i++) {
    const cl = cloud(height * (0.18 + Math.random() * 0.1), line * 0.7);
    cl.x = ((i + 0.5) / clouds) * width + (Math.random() - 0.5) * width * 0.1;
    cl.y = height * (0.12 + Math.random() * 0.5);
    cl.label = "cloud";
    c.addChild(cl);
  }
  return c;
}

/** 2色を混ぜる（t=0 で a、t=1 で b） */
export function mix(a: number, b: number, t: number): number {
  const ch = (c: number, s: number) => (c >> s) & 0xff;
  const m = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t) << s;
  return m(16) | m(8) | m(0);
}

/** 風船（顔つき）。r は横の半径 */
export function balloon(r: number, color: number, line: number, withFace = true): Container {
  const c = new Container();
  const string = new Graphics()
    .moveTo(0, r * 1.25)
    .bezierCurveTo(r * 0.3, r * 1.6, -r * 0.3, r * 1.9, 0, r * 2.3)
    .stroke({ width: line * 0.6, color: palette.ink, alpha: 0.6 });
  const knot = new Graphics().poly([-r * 0.15, r * 1.32, r * 0.15, r * 1.32, 0, r * 1.12]).fill(color).stroke({ width: line * 0.7, color: palette.ink, join: "round" });
  const body = new Graphics().ellipse(0, 0, r, r * 1.2).fill(color).stroke({ width: line, color: palette.ink });
  const shine = new Graphics().ellipse(-r * 0.45, -r * 0.5, r * 0.18, r * 0.3).fill({ color: palette.white, alpha: 0.55 });
  shine.rotation = 0.5;
  c.addChild(string, knot, body, shine);
  if (withFace) {
    const f = face(r * 1.4);
    f.y = r * 0.1;
    f.label = "face";
    c.addChild(f);
  }
  return c;
}

/** 星 */
export function star(r: number, color: number, line: number): Graphics {
  return new Graphics().star(0, 0, 5, r, r * 0.5).fill(color).stroke({ width: line, color: palette.ink, join: "round" });
}

/**
 * いくつかの図形を重ねた形を、外側の輪郭だけで描く。
 * 下に太い線で全部の形を描き、上から塗りで内側の線を隠す。
 */
export function blobShape(draw: (g: Graphics) => void, color: number, line: number): Container {
  const c = new Container();
  const outline = new Graphics();
  draw(outline);
  outline.stroke({ width: line * 2, color: palette.ink, join: "round" });
  const fill = new Graphics();
  draw(fill);
  fill.fill(color);
  c.addChild(outline, fill);
  return c;
}

/** 雲 */
export function cloud(w: number, line: number, color: number = palette.white): Container {
  const h = w * 0.45;
  return blobShape(
    (g) => {
      g.roundRect(-w / 2, -h * 0.2, w, h * 0.7, h * 0.35);
      g.circle(-w * 0.2, -h * 0.15, h * 0.42);
      g.circle(w * 0.12, -h * 0.3, h * 0.5);
    },
    color,
    line,
  );
}
