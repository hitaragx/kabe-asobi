// 2D測域センサの1回分の走査（スキャン）と、機種ごとの仕様。

export interface ScanSpec {
  /** 機種名 */
  model: string;
  /** 1回の走査の点の数 */
  steps: number;
  /** 正面（角度0）にあたる点の番号 */
  frontStep: number;
  /** 1点あたりの角度（ラジアン） */
  angleIncrement: number;
  /** 測れる距離（mm） */
  minRange: number;
  maxRange: number;
  /** 1回の走査にかかる時間（ミリ秒） */
  scanPeriodMs: number;
}

/**
 * 北陽電機 UST-20LX の公開仕様（メーカー公開のカタログ値）。
 * 視野 270°、角度の細かさ 0.25°（1081点）、1走査 25ms、測定範囲 0.06〜20m。
 */
export const UST_20LX: ScanSpec = {
  model: "UST-20LX",
  steps: 1081,
  frontStep: 540,
  angleIncrement: (0.25 * Math.PI) / 180,
  minRange: 60,
  maxRange: 20000,
  scanPeriodMs: 25,
};

export interface Scan {
  seq: number;
  /** 取得時刻（Unixミリ秒） */
  t: number;
  /** 各点の距離（mm）。0 は測れなかった点 */
  ranges: number[];
}

/** 点の番号 → 角度（ラジアン、正面が0、反時計回りが正） */
export function stepAngle(spec: ScanSpec, step: number): number {
  return (step - spec.frontStep) * spec.angleIncrement;
}

/** 点の番号と距離 → センサー座標（メートル、前方が+x、左が+y） */
export function toSensorXY(spec: ScanSpec, step: number, rangeMm: number): { x: number; y: number } {
  const a = stepAngle(spec, step);
  const r = rangeMm / 1000;
  return { x: r * Math.cos(a), y: r * Math.sin(a) };
}
