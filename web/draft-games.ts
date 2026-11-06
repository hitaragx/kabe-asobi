// 下書き（web/games）の読み込み。壁の画面が読む web/live とは別のモジュールにしてある。
// 下書きは Claude が作っている最中に何度も保存される。同じモジュールで読んでいると、保存のたびに
// Vite が壁の画面ごと読み込み直してしまう（遊んでいる遊びが最初に戻り、音楽も止まる）。
// ここで更新を受け止めて（self-accept）、壁の画面まで伝わらないようにする。

import type { GameDefinition } from "./engine/game.ts";

export const loaders = import.meta.glob<{ default: GameDefinition }>("./games/*.ts");

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    // 下書き用の画面（?draft）は検証のたびに開き直すので、ここでは何もしない
  });
}
