// 合わせ込みの流れ（センサー座標 → 画面座標）。
// 1. 壁に印を順に出す。職員がその印を手でタッチし、少し押さえる
// 2. 押さえている間のセンサーの位置を記録する（手を離すまで次へ進まない）
// 3. 4点以上そろったら変換を計算する
// 4. 確認用の印をタッチしてもらい、ずれ（cm）を測る。合格ならファイルに保存する

import { type Homography, apply, fitHomography } from "./calibration.ts";
import type { Track } from "./detector.ts";

export interface CalibTarget {
  /** 画面の正規化座標 */
  x: number;
  y: number;
  /** 確認用の印か */
  check?: boolean;
}

export type CalibPhase = "idle" | "collect" | "check" | "done" | "failed";

export interface CalibState {
  phase: CalibPhase;
  targets: CalibTarget[];
  /** いま出している印の番号 */
  active: number;
  /** 記録したセンサー座標（メートル）。印の番号ごと */
  captured: ({ x: number; y: number } | null)[];
  /** 押さえている進み具合 0〜1 */
  holdProgress: number;
  /** 職員に見せる案内 */
  message: string;
  homography: Homography | null;
  /** 確認用の印でのずれ（cm） */
  checkErrorsCm: number[];
  /** 各点の当てはめのずれ（cm） */
  fitErrorsCm: number[];
}

export interface CalibOptions {
  /** 押さえる時間（ミリ秒） */
  holdMs: number;
  /** 押さえている間に動いてよい距離（メートル） */
  holdTolerance: number;
  /** 合格のずれ（cm） */
  passCm: number;
}

export const DEFAULT_TARGETS: CalibTarget[] = [
  { x: 0.1, y: 0.12 },
  { x: 0.9, y: 0.12 },
  { x: 0.9, y: 0.88 },
  { x: 0.1, y: 0.88 },
  { x: 0.5, y: 0.5, check: true },
  { x: 0.3, y: 0.7, check: true },
];

export class Calibrator {
  readonly opts: CalibOptions;
  state: CalibState;
  private hold: { id: number; start: number; samples: { x: number; y: number }[] } | null = null;
  private waitRelease = false;
  onChange: ((s: CalibState) => void) | null = null;

  constructor(opts: Partial<CalibOptions> = {}) {
    this.opts = { holdMs: 700, holdTolerance: 0.04, passCm: 5, ...opts };
    this.state = this.initial([]);
  }

  private initial(targets: CalibTarget[]): CalibState {
    return { phase: "idle", targets, active: 0, captured: targets.map(() => null), holdProgress: 0, message: "", homography: null, checkErrorsCm: [], fitErrorsCm: [] };
  }

  start(targets: CalibTarget[] = DEFAULT_TARGETS): void {
    if (targets.filter((t) => !t.check).length < 4) throw new Error("合わせ込みには4点以上の印が必要です");
    this.state = { ...this.initial(targets), phase: "collect", message: "光った まるを、手で タッチして 少し押さえてください" };
    this.hold = null;
    this.waitRelease = false;
    this.emit();
  }

  cancel(): void {
    this.state = this.initial([]);
    this.emit();
  }

  /** 1つの印だけやり直す */
  redo(index: number): void {
    const s = this.state;
    if (index < 0 || index >= s.targets.length) throw new Error(`印の番号が範囲外です: ${index}`);
    s.captured[index] = null;
    s.active = index;
    s.phase = s.targets[index]!.check ? "check" : "collect";
    s.message = `${index + 1}ばんの まるを、もう一度 タッチしてください`;
    this.emit();
  }

  get active(): boolean {
    return this.state.phase === "collect" || this.state.phase === "check";
  }

  /** スキャンごとに、追跡中の物体（センサー座標）を渡す */
  update(tracks: Track[], t: number): void {
    if (!this.active) return;
    const s = this.state;
    if (this.waitRelease) {
      if (tracks.length === 0) this.waitRelease = false;
      return;
    }
    // 押さえている物体：いちばん長く見えているもの
    const tr = [...tracks].sort((a, b) => a.firstSeen - b.firstSeen)[0];
    if (!tr) {
      if (this.hold) {
        this.hold = null;
        s.holdProgress = 0;
        this.emit();
      }
      return;
    }
    if (!this.hold || this.hold.id !== tr.id) this.hold = { id: tr.id, start: t, samples: [] };
    const first = this.hold.samples[0];
    if (first && Math.hypot(tr.x - first.x, tr.y - first.y) > this.opts.holdTolerance) {
      // 動いてしまったら、押さえ直し
      this.hold = { id: tr.id, start: t, samples: [] };
    }
    this.hold.samples.push({ x: tr.x, y: tr.y });
    const p = Math.min(1, (t - this.hold.start) / this.opts.holdMs);
    if (Math.abs(p - s.holdProgress) > 0.1 || p === 1) {
      s.holdProgress = p;
      this.emit();
    }
    if (p < 1) return;

    // 記録する（押さえている間の中央値）
    const xs = this.hold.samples.map((q) => q.x).sort((a, b) => a - b);
    const ys = this.hold.samples.map((q) => q.y).sort((a, b) => a - b);
    const pos = { x: xs[Math.floor(xs.length / 2)]!, y: ys[Math.floor(ys.length / 2)]! };
    s.captured[s.active] = pos;
    s.holdProgress = 0;
    this.hold = null;
    this.waitRelease = true;
    this.advance();
  }

  private advance(): void {
    const s = this.state;
    const next = s.captured.findIndex((c, i) => c === null && (s.phase === "check" || !s.targets[i]!.check));
    if (s.phase === "collect") {
      if (next >= 0) {
        s.active = next;
        s.message = `つぎは ${next + 1}ばんの まるです`;
        return this.emit();
      }
      // 変換を計算する
      const pairs = s.targets.flatMap((tg, i) => (!tg.check && s.captured[i] ? [{ sensor: s.captured[i]!, screen: { x: tg.x, y: tg.y } }] : []));
      const h = fitHomography(pairs);
      if (!h) {
        s.phase = "failed";
        s.message = "うまく計算できませんでした。もう一度はじめから やりましょう";
        return this.emit();
      }
      s.homography = h;
      s.fitErrorsCm = pairs.map((p) => this.errorCm(h, p.sensor, p.screen));
      s.phase = "check";
      const firstCheck = s.targets.findIndex((tg) => tg.check);
      if (firstCheck < 0) return this.finish();
      s.active = firstCheck;
      s.message = "さいごに、たしかめの まるを タッチしてください";
      return this.emit();
    }
    // 確認
    const nextCheck = s.targets.findIndex((tg, i) => tg.check && s.captured[i] === null);
    if (nextCheck >= 0) {
      s.active = nextCheck;
      s.message = "つぎの たしかめの まるを タッチしてください";
      return this.emit();
    }
    this.finish();
  }

  private finish(): void {
    const s = this.state;
    const h = s.homography!;
    s.checkErrorsCm = s.targets.flatMap((tg, i) => (tg.check && s.captured[i] ? [this.errorCm(h, s.captured[i]!, tg)] : []));
    const worst = Math.max(0, ...s.checkErrorsCm, ...s.fitErrorsCm);
    if (worst <= this.opts.passCm) {
      s.phase = "done";
      s.message = `あわせこみ 完了（ずれ ${worst.toFixed(1)}cm）`;
    } else {
      s.phase = "failed";
      s.message = `ずれが大きいです（${worst.toFixed(1)}cm）。もう一度 やりましょう`;
    }
    this.emit();
  }

  /**
   * ずれ（cm）：画面の目標位置をセンサー座標に戻し、タッチした位置との距離を測る。
   * センサー座標はメートルなので、そのまま実際の距離になる。
   */
  private errorCm(h: Homography, sensor: { x: number; y: number }, screen: { x: number; y: number }): number {
    const inv = invert3(h);
    if (!inv) return Infinity;
    const q = apply(inv, screen.x, screen.y);
    return Math.hypot(q.x - sensor.x, q.y - sensor.y) * 100;
  }

  private emit(): void {
    this.onChange?.(this.state);
  }
}

/** 3×3 行列の逆 */
export function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}
