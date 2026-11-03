// キャラクター：パーツ（耳・体・腕・顔）ごとに SVG で描き、パーツごとに動かす。
// 新しいキャラクターは CHARACTERS に1つ足せばよい（SVG は 100×100、中心が (50, 55)）。

import { Container, Graphics } from "pixi.js";
import { type Mood, face } from "./draw.ts";
import { type Motion, ease } from "./motion.ts";
import { palette } from "./style.ts";

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

interface PartSvg {
  /** 体より後ろに描くもの（耳など） */
  back?: string;
  body: string;
  /** 体の上に描く飾り（おなか・口元など） */
  front?: string;
  /** 腕（左右対称。左腕を描く。肩の位置 armPivot を中心に回す） */
  arm?: string;
  armPivot?: { x: number; y: number };
  /** 顔の中心と大きさ（SVG の座標） */
  faceAt: { x: number; y: number; size: number };
  /** くちばしなど、口の代わりがある場合は false */
  mouth?: boolean;
}

type Svg = (color: number, sub: number, ink: string, w: number) => PartSvg;

export const CHARACTERS: Record<string, { name: string; color: number; sub: number; svg: Svg }> = {
  bear: {
    name: "くま",
    color: 0xc98a5a,
    sub: 0xf3d3b0,
    svg: (c, s, ink, w) => ({
      back: `<svg><circle cx="24" cy="22" r="13" fill="${hex(c)}" stroke="${ink}" stroke-width="${w}"/><circle cx="76" cy="22" r="13" fill="${hex(c)}" stroke="${ink}" stroke-width="${w}"/><circle cx="24" cy="22" r="6" fill="${hex(s)}"/><circle cx="76" cy="22" r="6" fill="${hex(s)}"/></svg>`,
      body: `<svg><ellipse cx="50" cy="55" rx="40" ry="38" fill="${hex(c)}" stroke="${ink}" stroke-width="${w}"/></svg>`,
      front: `<svg><ellipse cx="50" cy="66" rx="17" ry="12" fill="${hex(s)}"/><ellipse cx="50" cy="60" rx="5" ry="3.5" fill="${ink}"/></svg>`,
      arm: `<svg><ellipse cx="12" cy="72" rx="9" ry="13" fill="${hex(c)}" stroke="${ink}" stroke-width="${w}"/></svg>`,
      armPivot: { x: 16, y: 62 },
      faceAt: { x: 50, y: 52, size: 62 },
    }),
  },
  cat: {
    name: "ねこ",
    color: 0xffb347,
    sub: 0xffffff,
    svg: (c, s, ink, w) => ({
      back: `<svg><path d="M18 40 L22 8 L44 26 Z" fill="${hex(c)}" stroke="${ink}" stroke-width="${w}" stroke-linejoin="round"/><path d="M82 40 L78 8 L56 26 Z" fill="${hex(c)}" stroke="${ink}" stroke-width="${w}" stroke-linejoin="round"/><path d="M24 30 L25 16 L36 26 Z" fill="${hex(palette.pink)}"/><path d="M76 30 L75 16 L64 26 Z" fill="${hex(palette.pink)}"/></svg>`,
      body: `<svg><ellipse cx="50" cy="56" rx="40" ry="36" fill="${hex(c)}" stroke="${ink}" stroke-width="${w}"/></svg>`,
      front: `<svg><path d="M30 64 L12 60 M30 69 L12 71 M70 64 L88 60 M70 69 L88 71" stroke="${ink}" stroke-width="${w * 0.6}" stroke-linecap="round"/><path d="M44 36 L50 44 L56 36" stroke="${hex(0xd9822b)}" stroke-width="${w}" fill="none" stroke-linecap="round"/><ellipse cx="50" cy="61" rx="3.5" ry="2.5" fill="${hex(palette.pink)}"/></svg>`,
      arm: `<svg><ellipse cx="13" cy="74" rx="8" ry="12" fill="${hex(s)}" stroke="${ink}" stroke-width="${w}"/></svg>`,
      armPivot: { x: 17, y: 64 },
      faceAt: { x: 50, y: 54, size: 62 },
    }),
  },
  ghost: {
    name: "おばけ",
    color: 0xf4f1ff,
    sub: 0xc9b8ff,
    svg: (c, _s, ink, w) => ({
      body: `<svg><path d="M14 58 C14 30 30 14 50 14 C70 14 86 30 86 58 L86 88 Q79 80 72 88 Q65 96 58 88 Q50 80 42 88 Q35 96 28 88 Q21 80 14 88 Z" fill="${hex(c)}" stroke="${ink}" stroke-width="${w}" stroke-linejoin="round"/></svg>`,
      arm: `<svg><path d="M16 58 Q4 60 6 70 Q12 72 17 66" fill="${hex(c)}" stroke="${ink}" stroke-width="${w}" stroke-linejoin="round"/></svg>`,
      armPivot: { x: 16, y: 60 },
      faceAt: { x: 50, y: 48, size: 60 },
    }),
  },
  chick: {
    name: "ひよこ",
    color: 0xffd23f,
    sub: 0xff9f1c,
    svg: (c, s, ink, w) => ({
      back: `<svg><path d="M46 18 Q44 4 52 8 Q50 12 56 10 Q54 16 52 19 Z" fill="${hex(c)}" stroke="${ink}" stroke-width="${w * 0.8}" stroke-linejoin="round"/></svg>`,
      body: `<svg><ellipse cx="50" cy="56" rx="38" ry="38" fill="${hex(c)}" stroke="${ink}" stroke-width="${w}"/></svg>`,
      front: `<svg><path d="M43 60 L57 60 L50 69 Z" fill="${hex(s)}" stroke="${ink}" stroke-width="${w * 0.7}" stroke-linejoin="round"/></svg>`,
      arm: `<svg><path d="M14 56 Q2 66 10 78 Q16 70 20 64 Z" fill="${hex(c)}" stroke="${ink}" stroke-width="${w}" stroke-linejoin="round"/></svg>`,
      armPivot: { x: 16, y: 58 },
      faceAt: { x: 50, y: 50, size: 58 },
      mouth: false,
    }),
  },
};

export type CharacterKind = keyof typeof CHARACTERS;

/** 動かせるキャラクター。パーツには label で名前がついている */
export interface Character extends Container {
  kind: string;
  mood: Mood;
  /** 顔の大きさ（表情を変えるときに使う） */
  faceSize: number;
  hasMouth: boolean;
}

/** キャラクターを作る。size は全体の幅（ピクセル）。原点は足元の中央 */
export function makeCharacter(kind: string, size: number, line: number, color?: number): Character {
  const def = CHARACTERS[kind] ?? CHARACTERS.bear!;
  const k = size / 100;
  const parts = def.svg(color ?? def.color, def.sub, hex(palette.ink), line / k);
  const root = new Container() as Character;
  root.kind = kind;
  root.mood = "smile";
  root.faceSize = parts.faceAt.size * k;
  root.hasMouth = parts.mouth !== false;
  // 体の揺れ（つぶれる・伸びる）は足元を中心にしたいので、中身を一段入れる
  const inner = new Container();
  inner.label = "inner";
  inner.y = -size * 0.94;
  root.addChild(inner);

  const svgPart = (svg: string | undefined, label: string): Graphics | null => {
    if (!svg) return null;
    const g = new Graphics().svg(svg);
    g.label = label;
    g.scale.set(k);
    g.x = -size / 2;
    return g;
  };
  const back = svgPart(parts.back, "back");
  const body = svgPart(parts.body, "body");
  const front = svgPart(parts.front, "front");
  if (back) inner.addChild(back);
  if (parts.arm && parts.armPivot) {
    for (const side of [-1, 1] as const) {
      // 肩を中心に回せるよう、肩の位置に入れ物を置く
      const holder = new Container();
      holder.label = side < 0 ? "armL" : "armR";
      // 左腕（side=-1）はそのまま、右腕（side=1）は左右反転して、肩が入れ物の原点に来るようにする
      holder.x = side * (50 - parts.armPivot.x) * k;
      holder.y = parts.armPivot.y * k;
      const g = new Graphics().svg(parts.arm);
      g.scale.set(-side * k, k);
      g.x = side * parts.armPivot.x * k;
      g.y = -parts.armPivot.y * k;
      holder.addChild(g);
      inner.addChild(holder);
    }
  }
  if (body) inner.addChild(body);
  if (front) inner.addChild(front);
  const f = face(parts.faceAt.size * k, "smile", palette.ink, root.hasMouth);
  f.label = "face";
  f.x = (parts.faceAt.x - 50) * k;
  f.y = parts.faceAt.y * k;
  inner.addChild(f);
  // 腕は体より手前に出す
  for (const l of ["armL", "armR"]) {
    const a = inner.getChildByLabel(l);
    if (a) inner.addChild(a);
  }
  return root;
}

/** 表情を変える */
export function setMood(ch: Character, mood: Mood): void {
  if (ch.mood === mood) return;
  const inner = ch.getChildByLabel("inner") as Container;
  const old = inner.getChildByLabel("face") as Container | null;
  if (!old) return;
  const f = face(ch.faceSize, mood, palette.ink, ch.hasMouth);
  f.label = "face";
  f.x = old.x;
  f.y = old.y;
  inner.addChildAt(f, inner.getChildIndex(old));
  old.destroy({ children: true });
  ch.mood = mood;
}

/** キャラクター用の動き */
export class CharacterMotion {
  constructor(private readonly m: Motion) {}

  private inner(ch: Character): Container {
    return ch.getChildByLabel("inner") as Container;
  }

  /** 息をするように、ゆっくり伸び縮みし、ときどきまばたきする（ずっと続く） */
  idle(ch: Character, periodMs = 1800): () => void {
    const inner = this.inner(ch);
    const y0 = inner.y;
    const phase = Math.random() * Math.PI * 2;
    let nextBlink = 1000 + Math.random() * 3000;
    return this.m.loop((dt, time) => {
      if (ch.destroyed) return false;
      const s = Math.sin((time / periodMs) * Math.PI * 2 + phase);
      inner.scale.set(1 + s * 0.015, 1 - s * 0.025);
      inner.y = y0 * inner.scale.y;
      nextBlink -= dt;
      if (nextBlink <= 0) {
        nextBlink = 2000 + Math.random() * 3000;
        const f = inner.getChildByLabel("face") as Container | null;
        if (f) void this.m.blink(f);
      }
    });
  }

  /** 両腕を上げて、ばんざい */
  async cheer(ch: Character, ms = 600): Promise<void> {
    const inner = this.inner(ch);
    const l = inner.getChildByLabel("armL") as Container | null;
    const r = inner.getChildByLabel("armR") as Container | null;
    if (!l || !r) return;
    await Promise.all([this.m.to(l, { rotation: 2.2 }, ms * 0.3, ease.outBack), this.m.to(r, { rotation: -2.2 }, ms * 0.3, ease.outBack)]);
    await this.m.wait(ms * 0.3);
    await Promise.all([this.m.to(l, { rotation: 0 }, ms * 0.4), this.m.to(r, { rotation: 0 }, ms * 0.4)]);
  }

  /** 片手を振る */
  async wave(ch: Character, times = 2): Promise<void> {
    const r = this.inner(ch).getChildByLabel("armR") as Container | null;
    if (!r) return;
    for (let i = 0; i < times; i++) {
      await this.m.to(r, { rotation: -2.4 }, 180, ease.outQuad);
      await this.m.to(r, { rotation: -1.6 }, 180, ease.inOutSine);
    }
    await this.m.to(r, { rotation: 0 }, 250);
  }

  /** うれしそうに跳ねる（表情も変わる） */
  async joy(ch: Character, height: number): Promise<void> {
    setMood(ch, "happy");
    const inner = this.inner(ch);
    await this.m.squash(inner, 0.2, 200);
    await Promise.all([this.m.hop(ch, height, 500), this.cheer(ch, 600)]);
    if (!ch.destroyed) setMood(ch, "smile");
  }

  /** びっくりする */
  async surprise(ch: Character): Promise<void> {
    setMood(ch, "surprised");
    await this.m.shake(ch, 6, 300);
    await this.m.wait(400);
    if (!ch.destroyed) setMood(ch, "smile");
  }
}
