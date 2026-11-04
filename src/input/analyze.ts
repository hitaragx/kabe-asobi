// 記録したスキャンを、指定した調整の値で流し直して、当たり検出の良し悪しを数える。
// Claude がセンサーの生のデータを読み、値を変えて、数字で確かめるための道具。

import { createReadStream, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { type Homography, apply } from "./calibration.ts";
import { Detector, type DetectorOptions } from "./detector.ts";
import { type Scan, type ScanSpec, UST_20LX } from "./scan.ts";

export interface Recording {
  spec: ScanSpec;
  knownHomography: Homography | null;
  scans: Scan[];
  truth: { t: number; x: number; y: number }[] | null;
}

export async function loadRecording(file: string): Promise<Recording> {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let spec: ScanSpec = UST_20LX;
  let knownHomography: Homography | null = null;
  let truth: Recording["truth"] = null;
  const scans: Scan[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.type === "header") {
      spec = o.spec;
      knownHomography = o.knownHomography ?? null;
      truth = o.truth ?? null;
    } else scans.push(o as Scan);
  }
  if (!scans.length) throw new Error(`記録が空です: ${file}`);
  return { spec, knownHomography, scans, truth };
}

export function listRecordings(dir = "recordings"): { file: string; sizeKb: number; modified: string }[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const st = statSync(`${dir}/${f}`);
        return { file: `${dir}/${f}`, sizeKb: Math.round(st.size / 1024), modified: st.mtime.toISOString() };
      })
      .sort((a, b) => a.modified.localeCompare(b.modified));
  } catch {
    return [];
  }
}

export interface AnalysisOptions {
  detector?: Partial<DetectorOptions>;
  /** 画面座標に直すための変換（あれば、画面の中に入った当たりの割合も出す） */
  homography?: Homography | null;
  /** 背景を覚えたあと、この時間（ms）は誰もいない前提で、誤反応を数える */
  quietMs?: number;
  /** 調べる区間（記録の先頭からの秒） */
  fromSec?: number;
  toSec?: number;
}

interface Done {
  id: number;
  t0: number;
  t1: number;
  x: number;
  y: number;
  maxWidth: number;
  maxPoints: number;
}

const q = (arr: number[], p: number) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor(s.length * p))]!.toFixed(3);
};

/** 記録を流し直して数える */
export function analyze(rec: Recording, opts: AnalysisOptions = {}) {
  const det = new Detector(rec.spec, opts.detector);
  const first = rec.scans[0]!.t;
  // 背景は記録の最初から通して覚える。数えるのだけ区間で絞る
  const inWindow = (t: number) => {
    const sec = (t - first) / 1000;
    return (opts.fromSec === undefined || sec >= opts.fromSec) && (opts.toSec === undefined || sec <= opts.toSec);
  };
  const scans = rec.scans.filter((s) => inWindow(s.t));
  let invalid = 0;
  let total = 0;
  let learnedAt: number | null = null;
  const open = new Map<number, Done>();
  const done: Done[] = [];
  const downs: { t: number; x: number; y: number }[] = [];

  for (const s of rec.scans) {
    const res = det.process(s);
    if (!inWindow(s.t)) continue;
    for (const r of s.ranges) {
      total++;
      if (r === 0) invalid++;
    }
    if (res.learning) continue;
    if (learnedAt === null) learnedAt = s.t;
    for (const e of res.events) {
      if (e.type === "down") {
        downs.push({ t: s.t, x: e.x, y: e.y });
        open.set(e.id, { id: e.id, t0: s.t, t1: s.t, x: e.x, y: e.y, maxWidth: 0, maxPoints: 0 });
      } else {
        const d = open.get(e.id);
        if (d) {
          d.t1 = s.t;
          done.push(d);
          open.delete(e.id);
        }
      }
    }
    for (const tr of res.tracks) {
      const d = open.get(tr.id);
      if (!d) continue;
      d.t1 = s.t;
      d.maxWidth = Math.max(d.maxWidth, tr.width);
      d.maxPoints = Math.max(d.maxPoints, tr.points);
      d.x = tr.x;
      d.y = tr.y;
    }
  }
  done.push(...open.values());

  // 遊びに届くのは画面の中（少しの余白つき）の当たりだけ（ハブと同じ扱い）
  let onScreen: number | null = null;
  const h = opts.homography ?? rec.knownHomography;
  const inScreen = (d: { x: number; y: number }) => {
    if (!h) return true;
    const p = apply(h, d.x, d.y);
    return p.x >= -0.05 && p.x <= 1.05 && p.y >= -0.05 && p.y <= 1.05;
  };
  const screenDowns = downs.filter(inScreen);
  if (h && downs.length) onScreen = +(screenDowns.length / downs.length).toFixed(2);

  const durMs = done.map((d) => d.t1 - d.t0);
  const bucket = (lo: number, hi: number) => durMs.filter((x) => x >= lo && x < hi).length;
  const seconds = scans.length ? (scans[scans.length - 1]!.t - scans[0]!.t) / 1000 : 0;


  // ずっと居座る物（3秒以上）：家具・人・カーテンの疑い
  const lingering = done
    .filter((d) => d.t1 - d.t0 >= 3000)
    .map((d) => ({ x: +d.x.toFixed(2), y: +d.y.toFixed(2), seconds: +((d.t1 - d.t0) / 1000).toFixed(1), width: +d.maxWidth.toFixed(2) }));

  // 当たりが集中した場所（センサー座標 25cm の升目）
  const grid = new Map<string, number>();
  for (const d of downs) {
    const k = `${(Math.floor(d.x / 0.25) * 0.25).toFixed(2)},${(Math.floor(d.y / 0.25) * 0.25).toFixed(2)}`;
    grid.set(k, (grid.get(k) ?? 0) + 1);
  }
  const hotspots = [...grid.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, n]) => ({ cell: k, downs: n }));

  const quietFalse =
    opts.quietMs && learnedAt !== null ? screenDowns.filter((d) => d.t >= learnedAt! && d.t < learnedAt! + opts.quietMs!).length : null;

  // 二重に数えた疑い：150ms 以内・15cm 以内に続いた当たり（画面の中）
  let doubles = 0;
  for (let i = 1; i < screenDowns.length; i++) {
    for (let j = i - 1; j >= 0 && screenDowns[i]!.t - screenDowns[j]!.t <= 150; j--) {
      if (Math.hypot(screenDowns[i]!.x - screenDowns[j]!.x, screenDowns[i]!.y - screenDowns[j]!.y) <= 0.15) {
        doubles++;
        break;
      }
    }
  }


  // 正解がある記録（模擬）なら、拾えた割合・誤って数えた数・ずれを出す
  let truthReport: { thrown: number; detected: number; recall: number; extraDowns: number; errorCm: { p50: number | null; p90: number | null } } | null = null;
  if (rec.truth && h) {
    const from = scans[0]?.t ?? 0;
    const to = scans[scans.length - 1]?.t ?? 0;
    const thrown = rec.truth.filter((b) => b.t >= from && b.t <= to);
    const used = new Set<number>();
    const errs: number[] = [];
    let detected = 0;
    // 画面の大きさ（m）は、変換の逆を使わず、近似として壁を2.4×1.5mとみなす（模擬の既定）
    for (const b of thrown) {
      let best = -1;
      let bestD = Infinity;
      screenDowns.forEach((d, i) => {
        if (used.has(i) || d.t < b.t - 30 || d.t > b.t + 120) return;
        const p = apply(h, d.x, d.y);
        const dist = Math.hypot((p.x - b.x) * 2.4, (p.y - b.y) * 1.5);
        if (dist < 0.1 && dist < bestD) {
          best = i;
          bestD = dist;
        }
      });
      if (best >= 0) {
        used.add(best);
        detected++;
        errs.push(bestD * 100);
      }
    }
    truthReport = {
      thrown: thrown.length,
      detected,
      recall: thrown.length ? +(detected / thrown.length).toFixed(2) : 0,
      extraDowns: screenDowns.length - used.size,
      errorCm: { p50: q(errs, 0.5), p90: q(errs, 0.9) },
    };
  }

  return {
    /** 正解がある記録（模擬）のときだけ：投げた数・拾えた数・割合・余計に数えた数・ずれ */
    truth: truthReport,
    options: det.options,
    seconds: +seconds.toFixed(1),
    scans: scans.length,
    scanRateHz: seconds ? +(scans.length / seconds).toFixed(1) : 0,
    invalidRatio: total ? +(invalid / total).toFixed(3) : 0,
    backgroundLearnedAtSec: learnedAt === null ? null : +((learnedAt - first) / 1000).toFixed(1),
    /** センサーが拾った当たり（画面の外も含む） */
    downsAll: downs.length,
    /** 遊びに届く当たり（画面の中） */
    downs: screenDowns.length,
    downsPerMinute: seconds ? +((screenDowns.length / seconds) * 60).toFixed(1) : 0,
    /** 誰もいないはずの時間の当たり（誤反応） */
    quietFalseDowns: quietFalse,
    /** 二重に数えた疑い */
    suspectedDoubles: doubles,
    /** 当たりのうち、画面の中に入った割合（合わせ込みがあるとき） */
    onScreenRatio: onScreen,
    durationsMs: { "<50": bucket(0, 50), "50-150": bucket(50, 150), "150-500": bucket(150, 500), "500-3000": bucket(500, 3000), ">=3000": bucket(3000, Infinity) },
    widthM: { p50: q(done.map((d) => d.maxWidth), 0.5), p90: q(done.map((d) => d.maxWidth), 0.9) },
    pointsP50: q(done.map((d) => d.maxPoints), 0.5),
    lingering,
    hotspots,
  };
}

export type Analysis = ReturnType<typeof analyze>;
