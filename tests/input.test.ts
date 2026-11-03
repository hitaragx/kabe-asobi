import { describe, expect, it } from "vitest";
import { apply, fitHomography, residuals, toMeters } from "../src/input/calibration.ts";
import { Pipeline } from "../src/input/pipeline.ts";
import { UST_20LX } from "../src/input/scan.ts";
import { Simulator, addRandomBalls, ballHit, handTouch } from "../src/input/sim/simulator.ts";
import type { WallEvent } from "../src/shared/protocol.ts";

const PERIOD = UST_20LX.scanPeriodMs;

/** 背景を覚えさせたあと、[from, to) の間スキャンを流して down イベントを集める */
function run(sim: Simulator, pipe: Pipeline, from: number, to: number) {
  const downs: (WallEvent & { t: number })[] = [];
  let seq = 0;
  for (let t = 0; t < to; t += PERIOD) {
    const f = pipe.process(sim.scanAt(t, seq++));
    if (f && t >= from) for (const e of f.events) if (e.type === "down") downs.push({ ...e, t });
  }
  return downs;
}

describe("模擬スキャン", () => {
  it("公開仕様どおり1081点で、何もなければ背景だけ", () => {
    const sim = new Simulator({ noiseMm: 0, dropoutRate: 0 });
    const s = sim.scanAt(0, 0);
    expect(s.ranges).toHaveLength(1081);
    // 正面（真下）は床までの距離 ≒ 1.5 + 0.5 + 0.1 = 2.1m
    expect(s.ranges[540]).toBeGreaterThan(2000);
    expect(s.ranges[540]).toBeLessThan(2200);
  });
});

describe("合わせ込み", () => {
  it("4点の対応から、正解の変換をほぼ再現できる", () => {
    const sim = new Simulator({ pose: { heading: Math.PI / 2 + 0.1, x: 0.3, y: -0.05 } });
    const H = sim.trueHomography();
    // 正解の変換の逆向きは使わず、壁の4点をセンサー座標に置いて作る
    const targets = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x: 0.1, y: 0.9 },
    ];
    const pairs = targets.map((screen) => {
      // 画面 → 壁 → センサー（回転と平行移動の逆）
      const wx = screen.x * sim.wallWidth - sim.pose.x;
      const wy = screen.y * sim.wallHeight - sim.pose.y;
      const c = Math.cos(sim.pose.heading);
      const s = Math.sin(sim.pose.heading);
      return { sensor: { x: wx * c + wy * s, y: -wx * s + wy * c }, screen };
    });
    for (const p of pairs) {
      const q = apply(H, p.sensor.x, p.sensor.y);
      expect(q.x).toBeCloseTo(p.screen.x, 6);
      expect(q.y).toBeCloseTo(p.screen.y, 6);
    }
    const fit = fitHomography(pairs)!;
    expect(fit).not.toBeNull();
    for (const r of residuals(fit, pairs)) expect(r).toBeLessThan(1e-6);
    const q = apply(fit, ...([pairs[0]!.sensor.x, pairs[0]!.sensor.y] as const));
    expect(q.x).toBeCloseTo(0.1, 6);
  });

  it("点が足りないときは null", () => {
    expect(fitHomography([])).toBeNull();
  });
});

describe("当たり検出", () => {
  it("ボールの当たりを1回だけ、5cm以内の位置で拾う", () => {
    const sim = new Simulator({ seed: 3 });
    const pipe = new Pipeline(sim.spec, { source: "sim", homography: sim.trueHomography() });
    const hits = [
      { x: 0.4, y: 0.4 },
      { x: 1.2, y: 0.8 },
      { x: 2.0, y: 1.3 },
      { x: 0.2, y: 1.4 },
    ];
    hits.forEach((h, i) => sim.add(ballHit(h.x, h.y, 1500 + i * 500, 50)));
    const downs = run(sim, pipe, 1000, 4000);
    expect(downs).toHaveLength(hits.length);
    downs.forEach((d, i) => {
      const truth = sim.wallToScreen(hits[i]!.x, hits[i]!.y);
      const err = toMeters(d.x - truth.x, d.y - truth.y, sim.wallWidth, sim.wallHeight);
      expect(err).toBeLessThan(0.05);
    });
  });

  it("手でなぞっても、タッチは1回として扱う", () => {
    const sim = new Simulator({ seed: 4 });
    const pipe = new Pipeline(sim.spec, { source: "sim", homography: sim.trueHomography() });
    sim.add(handTouch(0.6, 0.7, 1500, 800, 0.8, 0));
    expect(run(sim, pipe, 1000, 3000)).toHaveLength(1);
  });

  it("何もないときに誤って反応しない", () => {
    const sim = new Simulator({ seed: 5 });
    const pipe = new Pipeline(sim.spec, { source: "sim", homography: sim.trueHomography() });
    expect(run(sim, pipe, 1000, 10000)).toHaveLength(0);
  });

  it("3人が次々に投げても、ほとんど取りこぼさない", () => {
    const sim = new Simulator({ seed: 6 });
    const pipe = new Pipeline(sim.spec, { source: "sim", homography: sim.trueHomography() });
    const thrown = addRandomBalls(sim, { startMs: 1500, durationMs: 20000, players: 3, intervalMs: 1200 });
    const downs = run(sim, pipe, 1000, 22000);
    const rate = downs.length / thrown.length;
    expect(rate).toBeGreaterThan(0.9);
    expect(rate).toBeLessThan(1.1);
  });
});
