// スキャン → 当たり検出 → 合わせ込み → 共通の形式（WallFrame）。

import type { WallEvent, WallFrame, WallPoint } from "../shared/protocol.ts";
import { type Homography, apply } from "./calibration.ts";
import { Detector, type DetectorOptions, type DetectorResult } from "./detector.ts";
import type { Scan, ScanSpec } from "./scan.ts";

export interface PipelineOptions {
  source: string;
  homography: Homography | null;
  /** 投影範囲の外側でも、この幅までは受け付ける（正規化座標） */
  margin?: number;
  detector?: Partial<DetectorOptions>;
}

export class Pipeline {
  readonly detector: Detector;
  homography: Homography | null;
  private readonly source: string;
  private readonly margin: number;
  /** 画面の外で始まった物体は、最後まで送らない */
  private readonly hidden = new Set<number>();
  /** 最後の検出結果（合わせ込みやMCPから使う） */
  last: DetectorResult | null = null;

  constructor(spec: ScanSpec, opts: PipelineOptions) {
    this.detector = new Detector(spec, opts.detector);
    this.homography = opts.homography;
    this.source = opts.source;
    this.margin = opts.margin ?? 0.05;
  }

  process(scan: Scan): WallFrame | null {
    const res = this.detector.process(scan);
    this.last = res;
    if (res.learning || !this.homography) return null;
    const h = this.homography;
    const inside = (p: { x: number; y: number }) =>
      p.x >= -this.margin && p.x <= 1 + this.margin && p.y >= -this.margin && p.y <= 1 + this.margin;

    const events: WallEvent[] = [];
    for (const e of res.events) {
      const q = apply(h, e.x, e.y);
      if (e.type === "down" && !inside(q)) {
        this.hidden.add(e.id);
        continue;
      }
      if (this.hidden.has(e.id)) {
        if (e.type === "up") this.hidden.delete(e.id);
        continue;
      }
      events.push({ type: e.type, id: e.id, x: q.x, y: q.y });
    }

    const points: WallPoint[] = [];
    for (const tr of res.tracks) {
      if (this.hidden.has(tr.id)) continue;
      const q = apply(h, tr.x, tr.y);
      if (!inside(q)) continue;
      // 速度も画面座標に直す（短い時間の差分で近似）
      const q2 = apply(h, tr.x + tr.vx * 0.01, tr.y + tr.vy * 0.01);
      points.push({ id: tr.id, x: q.x, y: q.y, vx: (q2.x - q.x) / 0.01, vy: (q2.y - q.y) / 0.01, conf: tr.conf });
    }

    return { v: 1, source: this.source, seq: scan.seq, t_capture: scan.t, points, events };
  }
}
