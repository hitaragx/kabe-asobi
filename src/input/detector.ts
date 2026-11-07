// スキャン → 壁に当たった物体の位置（センサー座標、メートル）。
// 1. 何もないときの距離（背景）を覚える
// 2. 背景より手前に何かがある点を拾う
// 3. 隣り合う点をまとめて1つの物体にする
// 4. 前のスキャンの物体と対応づけてIDを振り、現れた・消えた瞬間をイベントにする

import { type Scan, type ScanSpec, toSensorXY } from "./scan.ts";

export interface DetectorOptions {
  /** 背景を覚えるのに使うスキャンの数 */
  backgroundScans: number;
  /** 背景よりこれ以上手前なら「何かある」とみなす（mm） */
  foregroundThresholdMm: number;
  /** 同じ物体とみなす隣の点との距離（メートル） */
  clusterGap: number;
  /** 1つの物体として認める点の数・幅 */
  minPoints: number;
  maxWidth: number;
  /** 前のスキャンの物体と同じとみなす距離（メートル） */
  trackGate: number;
  /** 見えなくなってから「離れた」とみなすまでの時間（ミリ秒） */
  lostMs: number;
  /** この距離より近い・遠い点は無視する（メートル。0 なら制限なし） */
  minDistance: number;
  maxDistance: number;
  /**
   * 同じ瞬間に、いま見えている物のこれ以内（m）に現れたまとまりは、新しい当たりとして数えない（0で数える）。
   * 1つのボールが測れない点で2つに割れたり、手と腕が別々に見えたりして、二重に数えるのを防ぐ
   */
  mergeDist: number;
  /** 無視する場所（センサー座標の長方形、メートル）。家具・カーテン・柱など */
  ignoreRects: { x0: number; y0: number; x1: number; y1: number }[];
}

/** 調整できる値の説明（壁サーバーの道具で Claude に見せる） */
export const DETECTOR_HELP: Record<keyof DetectorOptions, string> = {
  backgroundScans: "背景を覚えるのに使うスキャンの数（40で約1秒）",
  foregroundThresholdMm: "背景よりこれ以上手前なら物とみなす（mm）。ノイズで誤反応するなら上げる。壁に近いボールを拾えないなら下げる",
  clusterGap: "隣の点とこれ以内なら同じ物（m）",
  minPoints: "1つの物として認める最小の点の数。小さいノイズを拾うなら上げる。遠くのボールを拾えないなら下げる",
  maxWidth: "1つの物として認める最大の幅（m）。人の体や家具を拾うなら下げる",
  trackGate: "前のスキャンの物と同じとみなす距離（m）。速く動く物が二重に数えられるなら上げる",
  lostMs: "見えなくなってから離れたとみなすまで（ms）。1回の当たりが2回に数えられるなら上げる",
  minDistance: "これより近い点は無視（m、0で制限なし）",
  maxDistance: "これより遠い点は無視（m、0で制限なし）。壁の外の部屋の物を拾うときに使う",
  mergeDist: "いま見えている物のこれ以内（m）に同じ瞬間に現れたものは、新しい当たりにしない。1回なのに2回数えるなら上げる。近くで同時に当てたのを1回にしてしまうなら下げる（0で無効）",
  ignoreRects: "無視する長方形（センサー座標 m の x0,y0,x1,y1）。家具・カーテンなど",
};

export const DEFAULT_DETECTOR: DetectorOptions = {
  backgroundScans: 40,
  foregroundThresholdMm: 60,
  // 本物のセンサーの誤差（±4cm程度）でも1つの物が分かれないよう、少し広めにする
  clusterGap: 0.1,
  minPoints: 3,
  maxWidth: 0.4,
  trackGate: 0.25,
  lostMs: 60,
  minDistance: 0,
  maxDistance: 0,
  mergeDist: 0.2,
  ignoreRects: [],
};

export interface Blob {
  x: number;
  y: number;
  width: number;
  points: number;
}

export interface Track {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  firstSeen: number;
  lastSeen: number;
  conf: number;
  /** 直近のまとまりの幅（m）と点の数 */
  width: number;
  points: number;
  /** 別の物の一部とみなした追跡（当たり・離れたを出さず、外にも見せない） */
  silent?: boolean;
}

export interface DetectorEvent {
  type: "down" | "up";
  id: number;
  x: number;
  y: number;
}

export interface DetectorResult {
  t: number;
  tracks: Track[];
  events: DetectorEvent[];
  blobs: Blob[];
  /** 背景を覚えている途中なら true */
  learning: boolean;
}

export class Detector {
  private opts: DetectorOptions;
  private bgSamples: number[][] = [];
  private background: number[] | null = null;
  private tracks: Track[] = [];
  private nextId = 1;

  constructor(
    private readonly spec: ScanSpec,
    opts: Partial<DetectorOptions> = {},
  ) {
    this.opts = { ...DEFAULT_DETECTOR, ...opts };
  }

  get options(): DetectorOptions {
    return structuredClone(this.opts);
  }

  /** 値を変える（ハブを止めずに）。知らない名前や範囲外の値はエラー */
  setOptions(values: Partial<DetectorOptions>): DetectorOptions {
    const next = { ...this.opts };
    for (const [k, v] of Object.entries(values)) {
      if (!(k in DEFAULT_DETECTOR)) throw new Error(`知らない値です: ${k}`);
      if (k === "ignoreRects") {
        if (!Array.isArray(v) || !v.every((r) => ["x0", "y0", "x1", "y1"].every((q) => Number.isFinite((r as Record<string, number>)[q]))))
          throw new Error("ignoreRects は {x0,y0,x1,y1} の配列で指定してください");
        next.ignoreRects = v as DetectorOptions["ignoreRects"];
      } else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) throw new Error(`${k} は0以上の数で指定してください`);
        (next as unknown as Record<string, number>)[k] = n;
      }
    }
    this.opts = next;
    return this.options;
  }

  get isLearning(): boolean {
    return this.background === null;
  }

  /** 背景を覚え直す（センサーを動かしたとき） */
  resetBackground(): void {
    this.bgSamples = [];
    this.background = null;
    this.tracks = [];
  }

  /** 保存しておいた背景を使う */
  setBackground(bg: number[]): void {
    this.background = bg.slice();
  }

  getBackground(): number[] | null {
    return this.background?.slice() ?? null;
  }

  process(scan: Scan): DetectorResult {
    if (!this.background) {
      this.bgSamples.push(scan.ranges);
      if (this.bgSamples.length >= this.opts.backgroundScans) {
        this.background = medianPerStep(this.bgSamples);
        this.bgSamples = [];
      }
      return { t: scan.t, tracks: [], events: [], blobs: [], learning: true };
    }
    const blobs = this.findBlobs(scan.ranges, this.background);
    const events = this.updateTracks(blobs, scan.t);
    return { t: scan.t, tracks: this.tracks.filter((tr) => !tr.silent).map((tr) => ({ ...tr })), events, blobs, learning: false };
  }

  private findBlobs(ranges: number[], bg: number[]): Blob[] {
    const { foregroundThresholdMm, clusterGap, minPoints, maxWidth, minDistance, maxDistance, ignoreRects } = this.opts;
    const ignored = (p: { x: number; y: number }) => {
      const d = Math.hypot(p.x, p.y);
      if (minDistance > 0 && d < minDistance) return true;
      if (maxDistance > 0 && d > maxDistance) return true;
      for (const r of ignoreRects) {
        if (p.x >= Math.min(r.x0, r.x1) && p.x <= Math.max(r.x0, r.x1) && p.y >= Math.min(r.y0, r.y1) && p.y <= Math.max(r.y0, r.y1)) return true;
      }
      return false;
    };
    const blobs: Blob[] = [];
    let cur: { x: number; y: number }[] = [];
    let last: { x: number; y: number } | null = null;
    let gapSteps = 0;

    const flush = () => {
      if (cur.length >= minPoints) {
        const first = cur[0]!;
        const lastP = cur[cur.length - 1]!;
        const width = Math.hypot(lastP.x - first.x, lastP.y - first.y);
        if (width <= maxWidth) {
          let mx = 0;
          let my = 0;
          for (const p of cur) {
            mx += p.x;
            my += p.y;
          }
          mx /= cur.length;
          my /= cur.length;
          // 見えているのは手前側の表面だけなので、中心は少し奥にある
          const r = Math.hypot(mx, my);
          const push = (width / 2) * 0.6;
          blobs.push({ x: (mx / r) * (r + push), y: (my / r) * (r + push), width, points: cur.length });
        }
      }
      cur = [];
      last = null;
    };

    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]!;
      const b = bg[i]!;
      const fg = r > 0 && (b === 0 || r < b - foregroundThresholdMm);
      if (!fg) {
        // 測れない点が1つ挟まっただけなら、まとまりを切らない
        if (r === 0 && cur.length > 0 && gapSteps < 1) {
          gapSteps++;
          continue;
        }
        flush();
        gapSteps = 0;
        continue;
      }
      gapSteps = 0;
      const p = toSensorXY(this.spec, i, r);
      if (ignored(p)) {
        flush();
        continue;
      }
      if (last && Math.hypot(p.x - last.x, p.y - last.y) > clusterGap) flush();
      cur.push(p);
      last = p;
    }
    flush();
    return blobs;
  }

  private updateTracks(blobs: Blob[], t: number): DetectorEvent[] {
    const events: DetectorEvent[] = [];
    const { trackGate, lostMs } = this.opts;
    const unmatched = new Set(blobs.map((_, i) => i));

    // 近い順に対応づける
    const pairs: { ti: number; bi: number; d: number }[] = [];
    this.tracks.forEach((tr, ti) => {
      const dtp = (t - tr.lastSeen) / 1000;
      const px = tr.x + tr.vx * dtp;
      const py = tr.y + tr.vy * dtp;
      blobs.forEach((b, bi) => {
        const d = Math.hypot(b.x - px, b.y - py);
        if (d <= trackGate) pairs.push({ ti, bi, d });
      });
    });
    pairs.sort((a, b) => a.d - b.d);
    const usedTracks = new Set<number>();
    for (const { ti, bi } of pairs) {
      if (usedTracks.has(ti) || !unmatched.has(bi)) continue;
      usedTracks.add(ti);
      unmatched.delete(bi);
      const tr = this.tracks[ti]!;
      const b = blobs[bi]!;
      const dt = Math.max((t - tr.lastSeen) / 1000, 1e-3);
      const a = 0.5; // 速度のなめらかさ
      tr.vx = a * ((b.x - tr.x) / dt) + (1 - a) * tr.vx;
      tr.vy = a * ((b.y - tr.y) / dt) + (1 - a) * tr.vy;
      tr.x = b.x;
      tr.y = b.y;
      tr.lastSeen = t;
      tr.conf = Math.min(1, tr.conf + 0.25);
      tr.width = b.width;
      tr.points = b.points;
    }

    // 見えなくなった物体
    this.tracks = this.tracks.filter((tr) => {
      if (t - tr.lastSeen > lostMs) {
        if (!tr.silent) events.push({ type: "up", id: tr.id, x: tr.x, y: tr.y });
        return false;
      }
      return true;
    });

    // 新しく現れた物体 = 当たった・触れた瞬間
    const { mergeDist } = this.opts;
    for (const bi of unmatched) {
      const b = blobs[bi]!;
      // この瞬間に見えている物（今回のスキャンで見えた追跡）のすぐそばなら、同じ物の一部とみなす
      const partOf = mergeDist > 0 && this.tracks.some((o) => o.lastSeen === t && Math.hypot(o.x - b.x, o.y - b.y) <= mergeDist);
      const tr: Track = { id: this.nextId++, x: b.x, y: b.y, vx: 0, vy: 0, firstSeen: t, lastSeen: t, conf: 0.5, width: b.width, points: b.points, ...(partOf ? { silent: true } : {}) };
      this.tracks.push(tr);
      if (!partOf) events.push({ type: "down", id: tr.id, x: tr.x, y: tr.y });
    }
    return events;
  }
}

function medianPerStep(samples: number[][]): number[] {
  const n = samples[0]?.length ?? 0;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const vals = samples.map((s) => s[i]!).filter((v) => v > 0);
    if (vals.length < samples.length / 2) {
      out[i] = 0; // ほとんど測れない方向は「背景なし」
      continue;
    }
    vals.sort((a, b) => a - b);
    out[i] = vals[Math.floor(vals.length / 2)]!;
  }
  return out;
}
