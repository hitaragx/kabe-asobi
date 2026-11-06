// 壁に出してよい遊び（web/live）の読み込み。publish_game で web/live が変わったときは、
// 壁の画面が読み込み直されて新しい版になる（これは意図した動き。下書きの読み込みは draft-games.ts）。

import type { GameDefinition } from "./engine/game.ts";

export const loaders = import.meta.glob<{ default: GameDefinition }>("./live/*.ts");
