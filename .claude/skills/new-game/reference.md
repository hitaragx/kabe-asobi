# 遊びの部品（web/engine）

```ts
import { defineGame } from "../engine/game.ts";
export default defineGame({
  id, title, description, rule, ages, input: "ボール" | "タッチ" | "どちらでも",
  params: { size: { value: 1, label: "的の大きさ", min: 0.5, max: 2 } },
  setup(ctx) { /* 絵を置く・ctx.onHit を登録する */ return { update(dtMs) {}, destroy() {} }; },
});
```

後片付け（絵・動き・タイマー・入力の登録）は枠が自動でする。`destroy` は、RenderTexture など枠が知らない物を作ったときだけ書く。

## ctx

| 名前 | 内容 |
|---|---|
| `stage` | 絵を置く入れ物（`ctx.stage.addChild(...)`） |
| `width`, `height`, `unit` | 画面の大きさ。`unit` は高さの1/100 |
| `params` | 調整できる値（職員の「もっと大きく」はここ） |
| `onHit(f)` / `onRelease(f)` | 当たった・離れた。`hit.x, hit.y` はピクセル |
| `touching()` | いま触れている点 |
| `near(hit, obj, r, slack=3)` | 当たりが物の近くか（子ども向けに少し甘め） |
| `zone(x, y)` | その場所の区画の倍率 `{ size, speed, label }`。的を作るときに掛ける（区画がなければ 1） |
| `zoneRect(x, y)` | その場所の区画の範囲（ピクセル）。動く的をこの中だけで動かす |
| `every(ms, f)` / `after(ms, f)` | くり返し・あとで |
| `random()` / `pick(arr)` | 乱数 |
| `setScore(text \| null)` | 上に点数などを出す |
| `announce(text, ms)` | 中央に大きく文字 |
| `finish(ms)` | 終わり。少し待って最初から |
| `line`, `colors`, `brights` | 輪郭の太さ、色 |

## ctx.motion（動き）

`to(obj, {x, y, alpha, rotation, scale, scaleX, scaleY}, ms, ease)`、`popIn`、`popOut`、`squash`（つぶれて戻る）、`hop`（跳ねる）、`shake`、`float`（ふわふわ）、`wobble`（ゆらゆら）、`drift(obj, vx, vy, {width, height, onExit})`（進む）、`path(obj, points, speed)`（道筋）、`flee(obj, from, radius, speed)`（逃げる）、`blink(face)`、`wait(ms)`、`loop(f)`（毎フレーム）。ease は `ease.outBack` など。

## ctx.fx（演出）

`burst(x, y, {color, count})`（はじける）、`ripple(x, y)`（波紋）、`popText(x, y, "+1")`、`confetti(width)`（紙吹雪）。

## ctx.sound（効果音）

`pop()`、`ding(pitch)`、`boing()`、`whoosh()`、`miss()`（やさしいはずれ）、`fanfare()`、`note(i)`（ドレミ）。

## 絵（web/engine/draw.ts）

`face(size, mood)`（mood：smile / happy / surprised / sleepy）、`balloon(r, color, line)`、`star(r, color, line)`、`cloud(w, line)`、`sky(width, height, line)`、`blobShape(draw, color, line)`（重ねた図形を外側の輪郭だけで）、`mix(a, b, t)`。

## キャラクター（web/engine/characters.ts）

`makeCharacter("bear" | "cat" | "chick" | "ghost", size, line)`（原点は足元）、`setMood(ch, mood)`。
`new CharacterMotion(ctx.motion)` で `idle(ch)`（息づかい・まばたき）、`cheer`、`wave`、`joy(ch, height)`、`surprise`。
新しいキャラクターは `CHARACTERS` に SVG（100×100）を1つ足す。
