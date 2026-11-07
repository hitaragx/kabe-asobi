// はじめから入っている遊び（見本）。職員の画面からは直せない・消せない。
// 職員モードの Claude も書き換えられない（src/server/assistant.ts の許可ルール、壁サーバーの publish_game・rollback_game）。
// 直したいときは、別の名前（ID）で新しい遊びとして作る。
export const PRESET_GAMES: readonly string[] = [
  "animal-band",
  "balloons",
  "bubbles",
  "cloud-clear",
  "hana-saku",
  "minna-hanabatake",
  "oni-taiji",
  "sakana",
  "team-battle",
  "tsukimi-usagi",
];

export const isPreset = (id: string): boolean => PRESET_GAMES.includes(id);
