// 合わせ込み：センサー座標（メートル）→ 画面の正規化座標（0〜1）の射影変換。
// 壁に出した印と、そこをタッチしたときのセンサーの位置の対応（4点以上）から求める。

export type Homography = number[]; // 行優先の3×3（h[8] = 1）

export interface Pair {
  sensor: { x: number; y: number };
  screen: { x: number; y: number };
}

export const IDENTITY: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function apply(h: Homography, x: number, y: number): { x: number; y: number } {
  const w = h[6]! * x + h[7]! * y + h[8]!;
  return { x: (h[0]! * x + h[1]! * y + h[2]!) / w, y: (h[3]! * x + h[4]! * y + h[5]!) / w };
}

/** 4点以上の対応から射影変換を求める（最小二乗）。点が足りない・一直線に並ぶときは null */
export function fitHomography(pairs: Pair[]): Homography | null {
  if (pairs.length < 4) return null;
  // 数値を安定させるため、両方の座標を正規化してから解く
  const ns = normalizer(pairs.map((p) => p.sensor));
  const nd = normalizer(pairs.map((p) => p.screen));
  const A: number[][] = [];
  const b: number[] = [];
  for (const p of pairs) {
    const s = applyAffine(ns.m, p.sensor);
    const d = applyAffine(nd.m, p.screen);
    A.push([s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y]);
    b.push(d.x);
    A.push([0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y]);
    b.push(d.y);
  }
  // 正規方程式 (AᵀA) h = Aᵀb
  const AtA = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const Atb = new Array<number>(8).fill(0);
  for (let r = 0; r < A.length; r++) {
    const row = A[r]!;
    for (let i = 0; i < 8; i++) {
      Atb[i]! += row[i]! * b[r]!;
      for (let j = 0; j < 8; j++) AtA[i]![j]! += row[i]! * row[j]!;
    }
  }
  const h8 = solve(AtA, Atb);
  if (!h8) return null;
  const hn = [...h8, 1];
  // 正規化を戻す：H = Nd⁻¹ · Hn · Ns
  const h = mul(mul(invertAffine(nd.m), hn), ns.m);
  const s = h[8]!;
  if (Math.abs(s) < 1e-12) return null;
  return h.map((v) => v / s);
}

/** 対応点のずれ（画面の正規化座標での距離） */
export function residuals(h: Homography, pairs: Pair[]): number[] {
  return pairs.map((p) => {
    const q = apply(h, p.sensor.x, p.sensor.y);
    return Math.hypot(q.x - p.screen.x, q.y - p.screen.y);
  });
}

/** 画面の正規化座標でのずれ → 実際の距離（メートル）。壁の投影範囲の大きさが必要 */
export function toMeters(dx: number, dy: number, wallWidth: number, wallHeight: number): number {
  return Math.hypot(dx * wallWidth, dy * wallHeight);
}

// ---- 行列の小道具 ----

function normalizer(pts: { x: number; y: number }[]): { m: number[] } {
  const n = pts.length;
  const cx = pts.reduce((a, p) => a + p.x, 0) / n;
  const cy = pts.reduce((a, p) => a + p.y, 0) / n;
  const d = pts.reduce((a, p) => a + Math.hypot(p.x - cx, p.y - cy), 0) / n || 1;
  const s = Math.SQRT2 / d;
  return { m: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1] };
}

function applyAffine(m: number[], p: { x: number; y: number }): { x: number; y: number } {
  return { x: m[0]! * p.x + m[1]! * p.y + m[2]!, y: m[3]! * p.x + m[4]! * p.y + m[5]! };
}

function invertAffine(m: number[]): number[] {
  // 拡大と平行移動だけの行列の逆
  const s = m[0]!;
  return [1 / s, 0, -m[2]! / s, 0, 1 / s, -m[5]! / s, 0, 0, 1];
}

function mul(a: number[], b: number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i * 3 + j]! += a[i * 3 + k]! * b[k * 3 + j]!;
  return out;
}

/** ガウスの消去法（部分ピボット） */
function solve(M: number[][], v: number[]): number[] | null {
  const n = v.length;
  const a = M.map((row, i) => [...row, v[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
    if (Math.abs(a[p]![c]!) < 1e-12) return null;
    [a[c], a[p]] = [a[p]!, a[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r]![c]! / a[c]![c]!;
      for (let k = c; k <= n; k++) a[r]![k]! -= f * a[c]![k]!;
    }
  }
  return a.map((row, i) => row[n]! / row[i]!);
}
