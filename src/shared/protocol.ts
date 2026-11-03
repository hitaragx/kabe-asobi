// 入力側（センサー）から遊び側（ブラウザ）へ送る共通の形式。
// 遊びはセンサーの種類を知らず、この形式だけを受け取る。

/** 画面上の点。x, y は 0〜1 の正規化座標（左上が原点、y は下向き） */
export interface WallPoint {
  /** 追跡ID。同じ物体なら同じID */
  id: number;
  x: number;
  y: number;
  /** 速度（正規化座標/秒） */
  vx: number;
  vy: number;
  /** 確からしさ 0〜1 */
  conf: number;
}

/**
 * 当たりのイベント。
 * - down：何かが壁に当たった・触れた瞬間（ボールの当たり、手のタッチの始まり）
 * - up：離れた瞬間
 */
export interface WallEvent {
  type: "down" | "up";
  id: number;
  x: number;
  y: number;
}

export interface WallFrame {
  v: 1;
  /** 入力元の名前（例：lidar-1、sim、replay、mouse） */
  source: string;
  seq: number;
  /** センサーが取得した時刻（Unixミリ秒） */
  t_capture: number;
  points: WallPoint[];
  events: WallEvent[];
}

/** ハブ ⇄ ブラウザ間でやりとりするメッセージ */
export type HubMessage =
  | { kind: "frame"; frame: WallFrame }
  | { kind: "status"; sensor: "ok" | "lost" | "starting"; source: string; detail?: string };

export const HUB_PORT = 8787;
