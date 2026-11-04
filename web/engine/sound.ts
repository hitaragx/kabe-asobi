// 効果音：外部の音素材は使わず、Web Audio で合成する。
// ブラウザは最初の操作があるまで音を出せないため、unlock() を一度呼ぶ必要がある。

// 音の出口は2つ：効果音（master）と音楽（musicBus）。音量は別々に変えられる。

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let musicBus: GainNode | null = null;
let musicDuck: GainNode | null = null;
let musicOutNode: AudioNode | null = null;
let volume = 0.6;
let musicVolume = 0.4;
const unlockListeners = new Set<() => void>();

export function unlockAudio(): void {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
    // 音楽：音量 → 効果音のときに少し下げる → やわらかくする（高い音を少し削る）
    musicBus = ctx.createGain();
    musicBus.gain.value = musicVolume * MUSIC_SCALE;
    musicDuck = ctx.createGain();
    const soft = ctx.createBiquadFilter();
    soft.type = "lowpass";
    soft.frequency.value = 5000;
    musicBus.connect(musicDuck).connect(soft).connect(ctx.destination);
    musicOutNode = soft;
  }
  void ctx.resume().then(() => {
    for (const f of unlockListeners) f();
  });
}

/** 音が出せるようになったら呼ぶ（音楽を始めるため） */
export function onAudioUnlock(f: () => void): void {
  unlockListeners.add(f);
}

/** 音楽は効果音より小さく聞こえるように、音量に掛ける係数 */
const MUSIC_SCALE = 1;

/** 効果音の音量（0〜1） */
export function setVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  if (master) master.gain.value = volume;
}
/** 音楽の音量（0〜1）。0 で止まる */
export function setMusicVolume(v: number): void {
  musicVolume = Math.max(0, Math.min(1, v));
  if (ctx && musicBus) musicBus.gain.setTargetAtTime(musicVolume * MUSIC_SCALE, ctx.currentTime, 0.15);
}
export const volumes = () => ({ sfx: volume, music: musicVolume });

/** 音楽の出口（まだ音が出せないときは null） */
export function musicOut(): { ac: AudioContext; out: GainNode } | null {
  if (!ctx || !musicBus || ctx.state !== "running") return null;
  return { ac: ctx, out: musicBus };
}

/**
 * 確認用：スピーカーに出ている音（効果音＋音楽）を ms ミリ秒録って、WAV（16bit・モノラル）で返す。
 * 壁の画面を ?debug で開いたときだけ window.__kabe から使う。
 */
export function recordWav(ms: number): Promise<ArrayBuffer> {
  if (!ctx || !master || !musicOutNode) return Promise.reject(new Error("音がまだ出せません"));
  const ac = ctx;
  const proc = ac.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  const mute = ac.createGain();
  mute.gain.value = 0;
  master.connect(proc);
  musicOutNode.connect(proc);
  proc.connect(mute).connect(ac.destination);
  return new Promise((resolve) =>
    setTimeout(() => {
      master!.disconnect(proc);
      musicOutNode!.disconnect(proc);
      proc.disconnect();
      const n = chunks.reduce((a, c) => a + c.length, 0);
      const buf = new ArrayBuffer(44 + n * 2);
      const v = new DataView(buf);
      const w = (o: number, str: string) => [...str].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
      w(0, "RIFF");
      v.setUint32(4, 36 + n * 2, true);
      w(8, "WAVEfmt ");
      v.setUint32(16, 16, true);
      v.setUint16(20, 1, true);
      v.setUint16(22, 1, true);
      v.setUint32(24, ac.sampleRate, true);
      v.setUint32(28, ac.sampleRate * 2, true);
      v.setUint16(32, 2, true);
      v.setUint16(34, 16, true);
      w(36, "data");
      v.setUint32(40, n * 2, true);
      let o = 44;
      for (const c of chunks)
        for (const x of c) {
          v.setInt16(o, Math.max(-1, Math.min(1, x)) * 0x7fff, true);
          o += 2;
        }
      resolve(buf);
    }, ms),
  );
}

/** 効果音が鳴った瞬間だけ、音楽を少し下げる（当たった音が聞こえやすいように） */
function duck(): void {
  if (!ctx || !musicDuck) return;
  const t = ctx.currentTime;
  musicDuck.gain.cancelScheduledValues(t);
  musicDuck.gain.setTargetAtTime(0.55, t, 0.02);
  musicDuck.gain.setTargetAtTime(1, t + 0.25, 0.25);
}

function ready(): { ac: AudioContext; out: GainNode } | null {
  if (!ctx || !master || ctx.state !== "running") return null;
  duck();
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

/**
 * 雑音で作る音（はじける・風を切る）。子ども向けに耳に痛くならないよう、
 * 鳴り始めを少しなめらかにし（attackMs）、高すぎる音を削る（lowpass）。
 */
function noise(ms: number, gain = 0.3, opts: { highpass?: number; lowpass?: number; attackMs?: number; sweepTo?: number } = {}): void {
  const r = ready();
  if (!r) return;
  const { ac, out } = r;
  const t0 = ac.currentTime;
  const len = Math.floor((ac.sampleRate * ms) / 1000);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const hp = ac.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = opts.highpass ?? 300;
  const lp = ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(opts.lowpass ?? 3500, t0);
  if (opts.sweepTo) lp.frequency.exponentialRampToValueAtTime(opts.sweepTo, t0 + ms / 1000);
  const g = ac.createGain();
  const attack = (opts.attackMs ?? 4) / 1000;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + attack);
  src.connect(hp).connect(lp).connect(g).connect(out);
  src.start(t0);
}

/** 遊びから使う効果音 */
export const sound = {
  /** 風船がわれる（「パンッ」と歯切れよく。ただし耳に刺さる高すぎる音は削る） */
  pop(): void {
    // はじける瞬間（短く明るい）＋ 余韻（少し低い）＋「ぽん」という芯
    noise(35, 0.42, { highpass: 900, lowpass: 6000, attackMs: 1 });
    noise(110, 0.22, { highpass: 400, lowpass: 3200, attackMs: 2, sweepTo: 900 });
    tone({ type: "triangle", from: 900, to: 260, ms: 100, gain: 0.45 });
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
  /** しゅっ（動き・出てくる）。ふわっと立ち上がり、音の高さが下がっていく */
  whoosh(): void {
    noise(260, 0.5, { highpass: 250, lowpass: 2200, attackMs: 40, sweepTo: 500 });
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
