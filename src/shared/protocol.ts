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
  /** ハブが送り出した時刻（Unixミリ秒）。遅れの内訳を測るのに使う */
  t_sent?: number;
  points: WallPoint[];
  events: WallEvent[];
}

/** BGM の雰囲気と、職員に見せる名前 */
export const MUSIC_STYLES = {
  nonbiri: "のんびり",
  nigiyaka: "にぎやか",
  wa: "和風",
  fushigi: "ふしぎ",
  kirakira: "きらきら",
  none: "なし",
} as const;
export type MusicStyle = keyof typeof MUSIC_STYLES;

/** 音の設定（壁全体。保存して、画面を開き直しても引き継ぐ） */
export interface AudioSettings {
  /** 音楽の音量 0〜10（0 で止まる） */
  music: number;
  /** 効果音の音量 0〜10 */
  sfx: number;
  /** 遊びごとの曲の雰囲気の上書き（遊びの ID → 雰囲気）。ない遊びは遊びの決めた雰囲気 */
  styles: Record<string, MusicStyle>;
}
export const DEFAULT_AUDIO: AudioSettings = { music: 4, sfx: 6, styles: {} };

/** 壁の画面への操作（壁サーバー → ハブ → ブラウザ） */
export type WallAction =
  | { action: "load"; id: string }
  | { action: "back" }
  | { action: "setParams"; id: string; values: Record<string, unknown> }
  | { action: "stats" }
  | { action: "games" }
  | { action: "snapshot" }
  | { action: "hit"; x: number; y: number }
  | { action: "reload" }
  | { action: "audio"; music?: number; sfx?: number; styles?: Record<string, MusicStyle | null> }
  | { action: "calibration"; view: CalibView | null }
  /** 壁の隅の「つくってるよ」表示。start で出す、done で「できた！」を見せて消す、off ですぐ消す */
  | { action: "making"; state: "start" | "done" | "off" };

/** 壁の画面に出す、合わせ込みの様子 */
export interface CalibView {
  phase: "idle" | "collect" | "check" | "done" | "failed";
  targets: { x: number; y: number; check?: boolean }[];
  active: number;
  captured: boolean[];
  holdProgress: number;
  message: string;
}

/** ハブ → ブラウザ */
export type HubMessage =
  | { kind: "frame"; frame: WallFrame }
  | { kind: "status"; sensor: "ok" | "lost" | "starting"; source: string; detail?: string }
  | ({ kind: "control"; reqId: number } & WallAction);

/** ブラウザ → ハブ */
export type ClientMessage =
  | { kind: "hello"; role: "wall" | "draft" }
  | { kind: "reply"; reqId: number; ok: boolean; data?: unknown; error?: string };

export const HUB_PORT = 8787;
