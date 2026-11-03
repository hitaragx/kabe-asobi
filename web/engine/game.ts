// 遊びの書き方。web/games/ に1遊び1ファイルで置き、defineGame で定義する。
//
//   export default defineGame({
//     id: "balloons", title: "ふうせんわり", rule: "的当て", ages: "3歳〜",
//     params: { size: { value: 1, label: "風船の大きさ" } },
//     setup(ctx) {
//       ctx.onHit((hit) => { ... });
//       return { update(dt) { ... } };
//     },
//   });
//
// 後片付け（絵・動き・タイマー・入力の登録）は枠が自動でする。遊びのコードは書かなくてよい。

import type { Application, Container } from "pixi.js";
import type { Fx } from "./fx.ts";
import type { Hit } from "./input.ts";
import type { Motion } from "./motion.ts";
import type { Sound } from "./sound.ts";
import type { palette } from "./style.ts";

/** ルールの型（docs/requirements.md F9） */
export type RuleType = "的当て" | "全部消す" | "みんなで協力" | "チーム対戦" | "色ぬり・陣取り" | "終わりのない遊び" | "その他";

export interface Param<T extends number | string | boolean = number | string | boolean> {
  value: T;
  /** 職員に見せる名前 */
  label: string;
  min?: number;
  max?: number;
}

export type Params = Record<string, Param>;
type Values<P extends Params> = { [K in keyof P]: P[K]["value"] };

export interface GameContext<P extends Params = Params> {
  app: Application;
  /** 遊びの絵を置く場所 */
  stage: Container;
  /** 画面の大きさ（ピクセル） */
  width: number;
  height: number;
  /** 大きさの単位（画面の高さの1/100）。大きさはこれの何倍かで書く */
  unit: number;
  /** 調整できる値（職員の「もっと大きく」などはここを変える） */
  params: Values<P>;

  motion: Motion;
  fx: Fx;
  sound: Sound;
  colors: typeof palette;
  brights: number[];
  /** 輪郭の太さ */
  line: number;

  /** 何かが壁に当たった・触れた */
  onHit(f: (hit: Hit) => void): void;
  /** 離れた */
  onRelease(f: (hit: Hit) => void): void;
  /** いま壁に触れている点 */
  touching(): { x: number; y: number; id: number }[];
  /** 当たりが物の近くか（子ども向けに少し甘めに判定する。slack は unit の何倍まで広げるか） */
  near(hit: { x: number; y: number }, obj: { x: number; y: number }, radius: number, slack?: number): boolean;

  every(ms: number, f: () => void): () => void;
  after(ms: number, f: () => void): () => void;
  /** 0〜1 の乱数 */
  random(): number;
  /** 配列から1つ選ぶ */
  pick<T>(arr: readonly T[]): T;

  /** 画面の上に点数などを出す（null で消す） */
  setScore(text: string | null): void;
  /** 画面の中央に大きく文字を出す */
  announce(text: string, ms?: number): void;
  /** 遊びが終わった（時間制など）。少し待って最初からやり直す */
  finish(afterMs?: number): void;
}

export interface GameInstance {
  update?(dtMs: number): void;
  destroy?(): void;
}

export interface GameDefinition<P extends Params = Params> {
  id: string;
  title: string;
  /** 遊び方の説明（職員向け、1〜2文） */
  description: string;
  rule: RuleType;
  /** 対象の年齢の目安 */
  ages: string;
  /** 遊び方：ボール／タッチ／どちらでも */
  input: "ボール" | "タッチ" | "どちらでも";
  params: P;
  setup(ctx: GameContext<P>): GameInstance | void;
}

export function defineGame<P extends Params>(def: GameDefinition<P>): GameDefinition<P> {
  return def;
}
