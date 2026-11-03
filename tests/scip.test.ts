import { type ChildProcess, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checksum, decode, encode, parseDistances, parseParams, parseResponse, specFromParams } from "../src/input/scip.ts";
import { LidarSource } from "../src/server/sources.ts";

const line = (s: string) => `${s}${checksum(s)}`;

describe("SCIP 2.0 の解析", () => {
  it("6ビット文字の変換が往復する", () => {
    for (const v of [0, 1, 63, 64, 1234, 20000, 262143]) expect(decode(encode(v, 3))).toBe(v);
    // 公開仕様の例：「CB」= 0x13, 0x12 → 1234
    expect(decode("CB")).toBe(1234);
  });

  it("行をまたぐ距離データを正しく取り出す", () => {
    const ranges = Array.from({ length: 100 }, (_, i) => 100 + i * 37);
    const data = ranges.map((r) => encode(r, 3)).join("");
    const lines = [line(encode(5000, 4))];
    for (let i = 0; i < data.length; i += 64) lines.push(line(data.slice(i, i + 64)));
    const r = parseDistances(parseResponse(["GD0000009900", line("00"), ...lines]));
    expect(r.timestamp).toBe(5000);
    expect(r.ranges).toEqual(ranges);
  });

  it("チェックサムが合わない行は受け付けない", () => {
    const bad = [line(encode(1, 4)), "0000000X"];
    expect(() => parseDistances(parseResponse(["GD", "00P", ...bad]))).toThrow();
  });

  it("PP から UST-20LX の仕様を作る", () => {
    const p = ["MODL:UST-20LX(Hokuyo)", "DMIN:20", "DMAX:60000", "ARES:1440", "AMIN:0", "AMAX:1080", "AFRT:540", "SCAN:2400"].map((s) => `${s};${checksum(`${s};`)}`);
    const spec = specFromParams(parseParams(parseResponse(["PP", "00P", ...p])));
    expect(spec.model).toBe("UST-20LX");
    expect(spec.steps).toBe(1081);
    expect(spec.frontStep).toBe(540);
    expect(spec.angleIncrement).toBeCloseTo((0.25 * Math.PI) / 180, 10);
    expect(spec.scanPeriodMs).toBeCloseTo(25, 6);
  });
});

describe("模擬 SCIP サーバーにつなぐ", () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  let server: ChildProcess;
  beforeAll(async () => {
    server = spawn("npx", ["tsx", "tools/fake-scip.ts", "--port", String(port), "--drop-after", "2"], { stdio: "pipe" });
    await new Promise<void>((resolve) => server.stdout!.on("data", (d) => String(d).includes("listen") && resolve()));
  }, 20000);
  afterAll(() => server.kill());

  it("距離を受け取り、切れても自動でつなぎ直す", async () => {
    const src = new LidarSource("127.0.0.1", port);
    const logs: string[] = [];
    let restarts = 0;
    src.onLog = (m) => logs.push(m);
    src.onRestart = () => restarts++;
    let scans = 0;
    let len = 0;
    await src.start((s) => {
      scans++;
      len = s.ranges.length;
    });
    // 2秒後に模擬サーバーが接続を切る → つなぎ直して、また届く
    await new Promise((r) => setTimeout(r, 4500));
    src.stop();
    expect(len).toBe(1081);
    expect(scans).toBeGreaterThan(100);
    expect(logs).toContain("lidar.disconnect");
    expect(restarts).toBeGreaterThanOrEqual(1);
  }, 15000);
});
