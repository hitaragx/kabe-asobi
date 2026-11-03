// 効果音：外部の音素材は使わず、Web Audio で合成する。
// ブラウザは最初の操作があるまで音を出せないため、unlock() を一度呼ぶ必要がある。

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let volume = 0.6;

export function unlockAudio(): void {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
  }
  void ctx.resume();
}

export function setVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  if (master) master.gain.value = volume;
}

function ready(): { ac: AudioContext; out: GainNode } | null {
  if (!ctx || !master || ctx.state !== "running") return null;
  return { ac: ctx, out: master };
}

/** 音の高さが変わる短い音 */
function tone(opts: {
  type?: OscillatorType;
  from: number;
  to?: number;
  ms: number;
  gain?: number;
  delayMs?: number;
}): void {
  const r = ready();
  if (!r) return;
  const { ac, out } = r;
  const t0 = ac.currentTime + (opts.delayMs ?? 0) / 1000;
  const t1 = t0 + opts.ms / 1000;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(opts.from, t0);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t1);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.4, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t1);
  osc.connect(g).connect(out);
  osc.start(t0);
  osc.stop(t1 + 0.02);
}

/** はじける音（短い雑音） */
function noise(ms: number, gain = 0.3, highpass = 1500): void {
  const r = ready();
  if (!r) return;
  const { ac, out } = r;
  const len = Math.floor((ac.sampleRate * ms) / 1000);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const f = ac.createBiquadFilter();
  f.type = "highpass";
  f.frequency.value = highpass;
  const g = ac.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(out);
  src.start();
}

/** 遊びから使う効果音 */
export const sound = {
  /** 風船がわれる */
  pop(): void {
    noise(120, 0.5, 1200);
    tone({ type: "triangle", from: 900, to: 300, ms: 90, gain: 0.25 });
  },
  /** 当たり・正解 */
  ding(pitch = 1): void {
    tone({ type: "sine", from: 880 * pitch, ms: 350, gain: 0.35 });
    tone({ type: "sine", from: 1320 * pitch, ms: 300, gain: 0.15, delayMs: 30 });
  },
  /** ぽよん（跳ねる） */
  boing(): void {
    tone({ type: "sine", from: 200, to: 600, ms: 180, gain: 0.4 });
  },
  /** しゅっ（動き・出てくる） */
  whoosh(): void {
    noise(250, 0.15, 600);
  },
  /** はずれ（やさしい音にする。子どもが悲しくならないように） */
  miss(): void {
    tone({ type: "triangle", from: 400, to: 330, ms: 160, gain: 0.15 });
  },
  /** できた！（ファンファーレ） */
  fanfare(): void {
    [523, 659, 784, 1047].forEach((f, i) =>
      tone({ type: "triangle", from: f, ms: i === 3 ? 600 : 160, gain: 0.3, delayMs: i * 130 }),
    );
  },
  /** ドレミ…の音（音階の番号 0〜） */
  note(i: number): void {
    const scale = [0, 2, 4, 5, 7, 9, 11];
    const semis = scale[((i % 7) + 7) % 7]! + 12 * Math.floor(i / 7);
    tone({ type: "triangle", from: 523.25 * 2 ** (semis / 12), ms: 300, gain: 0.3 });
  },
};

export type Sound = typeof sound;
