import { describe, expect, it } from "vitest";
import { apply } from "../src/input/calibration.ts";
import { Calibrator, DEFAULT_TARGETS } from "../src/input/calibrator.ts";
import { Detector } from "../src/input/detector.ts";
import { Simulator, handTouch } from "../src/input/sim/simulator.ts";

/** 職員が印を順にタッチする様子を模擬して、合わせ込みを通す */
function runCalibration(sim: Simulator, offsetCm = 0) {
  const det = new Detector(sim.spec);
  const cal = new Calibrator();
  cal.start();
  // 印の位置（画面）→ 壁の位置（メートル）に、少しずれてタッチする
  let t = 1500;
  for (const tg of DEFAULT_TARGETS) {
    sim.add(handTouch(tg.x * sim.wallWidth + offsetCm / 100, tg.y * sim.wallHeight, t, 1200));
    t += 2000;
  }
  for (let ms = 0, seq = 0; ms < t + 500; ms += 25) {
    const r = det.process(sim.scanAt(ms, seq++));
    if (!r.learning) cal.update(r.tracks, ms);
  }
  return cal.state;
}

describe("合わせ込みの流れ", () => {
  it("4点＋確認2点のタッチで合格し、正解とほぼ同じ変換になる", () => {
    const sim = new Simulator({ seed: 31, pose: { heading: Math.PI / 2 + 0.08, x: 1.0 } });
    const s = runCalibration(sim);
    expect(s.phase).toBe("done");
    expect(s.captured.every((c) => c !== null)).toBe(true);
    for (const e of s.checkErrorsCm) expect(e).toBeLessThan(5);
    // 壁の中央が、画面の中央に来る
    const H = sim.trueHomography();
    const inv = (() => {
      // 正解の変換で、画面の中央にあたるセンサー座標を探す（格子で近似）
      let best = { x: 0, y: 0, d: Infinity };
      for (let x = 0; x < 3; x += 0.005)
        for (let y = -2; y < 2; y += 0.005) {
          const q = apply(H, x, y);
          const d = Math.hypot(q.x - 0.5, q.y - 0.5);
          if (d < best.d) best = { x, y, d };
        }
      return best;
    })();
    const q = apply(s.homography!, inv.x, inv.y);
    expect(Math.hypot((q.x - 0.5) * sim.wallWidth, (q.y - 0.5) * sim.wallHeight)).toBeLessThan(0.03);
  });

  it("確認の印だけ大きくずれてタッチすると、不合格になる", () => {
    const sim = new Simulator({ seed: 32 });
    const det = new Detector(sim.spec);
    const cal = new Calibrator();
    cal.start();
    let t = 1500;
    for (const tg of DEFAULT_TARGETS) {
      const off = tg.check ? 0.15 : 0; // 確認だけ15cmずらす
      sim.add(handTouch(tg.x * sim.wallWidth + off, tg.y * sim.wallHeight, t, 1200));
      t += 2000;
    }
    for (let ms = 0, seq = 0; ms < t + 500; ms += 25) {
      const r = det.process(sim.scanAt(ms, seq++));
      if (!r.learning) cal.update(r.tracks, ms);
    }
    expect(cal.state.phase).toBe("failed");
    expect(Math.max(...cal.state.checkErrorsCm)).toBeGreaterThan(10);
  });
});

describe("居座る物体があるときの合わせ込み", () => {
  it("消えない物体があっても、職員が案内どおりにタッチし直せば合格する", () => {
    const sim = new Simulator({ seed: 33, pose: { heading: Math.PI / 2 + 0.05, x: 1.0 } });
    const det = new Detector(sim.spec);
    const cal = new Calibrator();
    cal.start();
    // 背景を覚えた直後に現れて、ずっと消えない物体（壁ぎわに立った人のつもり）。印の位置とは離れた場所
    sim.add(handTouch(0.5 * sim.wallWidth, 0.95 * sim.wallHeight, 1200, 60000));
    // 職員：案内（いまの印・言葉）が変わるたびに、少し待ってからその印をタッチする
    let lastKey = "";
    let busyUntil = 0;
    let touches = 0;
    let sawLingering = false;
    for (let ms = 0, seq = 0; ms < 40000 && cal.active; ms += 25) {
      const r = det.process(sim.scanAt(ms, seq++));
      if (r.learning) continue;
      cal.update(r.tracks, ms);
      if (cal.state.lingering > 0) sawLingering = true;
      const key = `${cal.state.phase}:${cal.state.active}:${cal.state.message}`;
      if (cal.active && ms >= busyUntil && key !== lastKey && !cal.state.message.includes("はなして")) {
        lastKey = key;
        const tg = DEFAULT_TARGETS[cal.state.active]!;
        sim.add(handTouch(tg.x * sim.wallWidth, tg.y * sim.wallHeight, ms + 400, 1200));
        busyUntil = ms + 400 + 1200 + 300;
        touches++;
      }
    }
    expect(sawLingering).toBe(true);
    expect(cal.state.phase).toBe("done");
    expect(touches).toBeGreaterThanOrEqual(6);
    for (const e of cal.state.checkErrorsCm) expect(e).toBeLessThan(5);
  });
});
