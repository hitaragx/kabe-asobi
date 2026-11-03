// スキャンの入力元：模擬センサー／記録の再生（本物のセンサーは T15 で追加）。

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Homography } from "../input/calibration.ts";
import { type Scan, type ScanSpec, UST_20LX } from "../input/scan.ts";
import { Simulator, addRandomBalls, handTouch, makeRng } from "../input/sim/simulator.ts";

export interface ScanSource {
  readonly name: string;
  readonly spec: ScanSpec;
  /** 合わせ込みの正解が分かっている入力元（模擬センサー）なら、その変換 */
  readonly knownHomography: Homography | null;
  start(onScan: (scan: Scan) => void): Promise<void>;
  stop(): void;
}

/** 記録ファイルの1行目 */
export interface RecordingHeader {
  type: "header";
  version: 1;
  spec: ScanSpec;
  source: string;
  /** 模擬センサーで記録した場合の正解の変換 */
  knownHomography?: Homography | null;
}

/** 模擬センサー：子どもたちがボールを投げ続ける場面をリアルタイムで作る */
export class SimSource implements ScanSource {
  readonly name = "sim";
  readonly spec: ScanSpec = UST_20LX;
  readonly sim: Simulator;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly opts: { players?: number; intervalMs?: number; touches?: boolean; seed?: number } = {},
  ) {
    this.sim = new Simulator({ seed: opts.seed ?? Date.now() % 100000 });
  }

  get knownHomography(): Homography {
    return this.sim.trueHomography();
  }

  async start(onScan: (scan: Scan) => void): Promise<void> {
    const t0 = Date.now();
    const rng = makeRng((this.opts.seed ?? 1) + 99);
    let seq = 0;
    let plannedUntil = 0;
    const CHUNK = 10000;
    this.timer = setInterval(() => {
      const t = Date.now() - t0;
      // 先の分の場面を少しずつ足していく
      while (plannedUntil < t + CHUNK) {
        addRandomBalls(this.sim, {
          startMs: plannedUntil + 1500,
          durationMs: CHUNK,
          players: this.opts.players ?? 3,
          intervalMs: this.opts.intervalMs ?? 1500,
          seed: Math.floor(rng() * 1e9),
        });
        if (this.opts.touches) {
          const x = 0.2 + rng() * (this.sim.wallWidth - 0.4);
          const y = 0.2 + rng() * (this.sim.wallHeight - 0.4);
          this.sim.add(handTouch(x, y, plannedUntil + 1500 + rng() * CHUNK, 600, (rng() - 0.5) * 0.6, 0));
        }
        plannedUntil += CHUNK;
      }
      this.sim.prune(t - 1000);
      onScan(this.sim.scanAt(t, seq++, t0));
    }, this.spec.scanPeriodMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** 記録の再生：記録したときと同じ間隔で流す。loop なら最後まで行ったら最初から */
export class ReplaySource implements ScanSource {
  readonly name = "replay";
  spec: ScanSpec = UST_20LX;
  knownHomography: Homography | null = null;
  private scans: Scan[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly file: string,
    private readonly loop = true,
  ) {}

  /** ファイルを読み込む（start の前に呼ぶ） */
  async load(): Promise<void> {
    const rl = createInterface({ input: createReadStream(this.file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line) as RecordingHeader | Scan;
      if ("type" in obj && obj.type === "header") {
        this.spec = obj.spec;
        this.knownHomography = obj.knownHomography ?? null;
      } else {
        this.scans.push(obj as Scan);
      }
    }
    if (this.scans.length === 0) throw new Error(`記録が空です: ${this.file}`);
  }

  async start(onScan: (scan: Scan) => void): Promise<void> {
    if (this.scans.length === 0) await this.load();
    const first = this.scans[0]!.t;
    const span = this.scans[this.scans.length - 1]!.t - first + this.spec.scanPeriodMs;
    let base = Date.now();
    let i = 0;
    let lap = 0;
    const tick = () => {
      if (this.stopped) return;
      const now = Date.now();
      // 予定時刻を過ぎたスキャンを流す（時刻は「今」に置き換え、遅延の計測が合うようにする）
      while (i < this.scans.length && first + (now - base) >= this.scans[i]!.t) {
        const s = this.scans[i]!;
        onScan({ seq: lap * this.scans.length + i, t: base + (s.t - first), ranges: s.ranges });
        i++;
      }
      if (i >= this.scans.length) {
        if (!this.loop) return;
        i = 0;
        lap++;
        base += span;
      }
      this.timer = setTimeout(tick, 5);
    };
    tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
