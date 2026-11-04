// BGM：外部の音素材は使わず、Web Audio でその場で作る。
// 雰囲気（style）ごとに、和音の進み方・速さ・楽器の組み合わせを決め、
// 遊びの ID から決まる乱数でメロディを作る（同じ遊びなら毎回同じ曲、8小節をくり返す）。
//
// 音量は sound.ts の setMusicVolume で変える（効果音とは別）。

import { MUSIC_STYLES, type MusicStyle } from "../../src/shared/protocol.ts";
import { musicOut, onAudioUnlock } from "./sound.ts";

export { MUSIC_STYLES, type MusicStyle };

interface StyleDef {
  bpm: number;
  /** 主音（MIDI の番号。60 がド） */
  root: number;
  /** 使う音（主音からの半音の数） */
  scale: number[];
  /** 1小節ごとの和音の根音（scale の何番目か）。8小節 */
  chords: number[];
  /** メロディの音色と、音の長さ（拍） */
  lead: { type: OscillatorType; octave: number; decay: number; gain: number };
  /** 1小節（8分音符8つ）のリズムの候補。1 = 音を出す、0 = 休む */
  rhythms: number[][];
  bass: { beats: number[]; type: OscillatorType; gain: number };
  pad: number;
  arp?: number;
  perc: "soft" | "taiko" | "shaker" | "none";
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const YO = [0, 2, 5, 7, 9]; // 和風（ヨナ抜きに近い明るい五音）
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];

const STYLES: Record<Exclude<MusicStyle, "none">, StyleDef> = {
  nonbiri: {
    bpm: 84,
    root: 60,
    scale: MAJOR,
    chords: [0, 5, 3, 4, 0, 5, 3, 4],
    lead: { type: "triangle", octave: 1, decay: 0.9, gain: 0.16 },
    rhythms: [
      [1, 0, 1, 0, 1, 0, 0, 0],
      [1, 0, 0, 1, 1, 0, 1, 0],
      [1, 0, 1, 0, 0, 0, 1, 0],
    ],
    bass: { beats: [0, 4], type: "sine", gain: 0.22 },
    pad: 0.035,
    perc: "none",
  },
  nigiyaka: {
    bpm: 116,
    root: 65,
    scale: MAJOR,
    chords: [0, 3, 4, 0, 5, 3, 4, 4],
    lead: { type: "square", octave: 0, decay: 0.35, gain: 0.07 },
    rhythms: [
      [1, 1, 0, 1, 1, 0, 1, 0],
      [1, 0, 1, 1, 0, 1, 1, 0],
      [1, 1, 1, 0, 1, 0, 1, 1],
    ],
    bass: { beats: [0, 2, 4, 6], type: "triangle", gain: 0.2 },
    pad: 0.02,
    perc: "soft",
  },
  wa: {
    bpm: 92,
    root: 62,
    scale: YO,
    chords: [0, 0, 3, 2, 0, 3, 4, 0],
    lead: { type: "triangle", octave: 1, decay: 0.45, gain: 0.15 },
    rhythms: [
      [1, 0, 1, 0, 1, 1, 0, 0],
      [1, 0, 0, 1, 0, 1, 1, 0],
      [1, 1, 0, 1, 1, 0, 0, 0],
    ],
    bass: { beats: [0], type: "sine", gain: 0.2 },
    pad: 0,
    perc: "taiko",
  },
  fushigi: {
    bpm: 70,
    root: 62,
    scale: LYDIAN,
    chords: [0, 1, 0, 1, 5, 4, 1, 0],
    lead: { type: "sine", octave: 1, decay: 1.2, gain: 0.13 },
    rhythms: [
      [1, 0, 0, 0, 1, 0, 0, 0],
      [1, 0, 0, 1, 0, 0, 1, 0],
      [0, 0, 1, 0, 1, 0, 0, 0],
    ],
    bass: { beats: [0], type: "sine", gain: 0.18 },
    pad: 0.045,
    arp: 0.03,
    perc: "none",
  },
  kirakira: {
    bpm: 100,
    root: 67,
    scale: MAJOR,
    chords: [0, 4, 5, 3, 0, 4, 3, 4],
    lead: { type: "sine", octave: 1, decay: 0.6, gain: 0.14 },
    rhythms: [
      [1, 0, 1, 0, 1, 0, 1, 0],
      [1, 0, 0, 1, 1, 0, 1, 0],
      [1, 1, 0, 1, 0, 0, 1, 0],
    ],
    bass: { beats: [0, 4], type: "sine", gain: 0.16 },
    pad: 0.03,
    arp: 0.035,
    perc: "shaker",
  },
};

function rng(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const freq = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** scale の degree 番目の音（オクターブをまたいでよい） */
function pitch(s: StyleDef, degree: number, octave = 0): number {
  const n = s.scale.length;
  const o = Math.floor(degree / n);
  const d = ((degree % n) + n) % n;
  return s.root + s.scale[d]! + 12 * (o + octave);
}

/** 8小節のメロディを作る。前半4小節の形を後半でくり返し、最後は主音で終わる */
function compose(s: StyleDef, seed: string): (number | null)[][] {
  const r = rng(seed);
  const n = s.scale.length;
  const bars: (number | null)[][] = [];
  let deg = n; // 1オクターブ上の主音あたりから
  for (let b = 0; b < 8; b++) {
    if (b >= 4 && b < 7) {
      // 後半は前半の形をなぞる（覚えやすさ）。少しだけ変える
      bars.push(bars[b - 4]!.map((d) => (d !== null && r() < 0.2 ? d + (r() < 0.5 ? 1 : -1) : d)));
      continue;
    }
    const rhythm = s.rhythms[Math.floor(r() * s.rhythms.length)]!;
    const chord = s.chords[b]!;
    const bar: (number | null)[] = [];
    for (let i = 0; i < 8; i++) {
      if (!rhythm[i]) {
        bar.push(null);
        continue;
      }
      if (i === 0 || i === 4) {
        // 強い拍は和音の音に寄せる
        const tones = [chord, chord + 2, chord + 4].map((t) => t + n * Math.round((deg - t) / n));
        deg = tones.reduce((a, t) => (Math.abs(t - deg) < Math.abs(a - deg) ? t : a), tones[0]!);
      } else {
        deg += [-2, -1, -1, 1, 1, 2][Math.floor(r() * 6)]!;
      }
      deg = Math.max(n - 2, Math.min(2 * n + 2, deg));
      bar.push(deg);
    }
    if (b === 7) bar.splice(0, 8, ...[n + s.chords[7]!, null, null, null, n, null, null, null]);
    bars.push(bar);
  }
  return bars;
}

class MusicPlayer {
  private key = "";
  private pending: { style: MusicStyle; seed: string } | null = null;
  private song: { s: StyleDef; melody: (number | null)[][]; gain: GainNode; next: number; step: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private idle = false;

  constructor() {
    onAudioUnlock(() => {
      if (this.pending) {
        const p = this.pending;
        this.key = "";
        this.play(p.style, p.seed);
      }
    });
  }

  /** いまの曲（style と seed） */
  get current(): string {
    return this.key;
  }

  /** 曲を始める。同じ曲が流れていれば何もしない（遊びのやり直しで曲が途切れないように） */
  play(style: MusicStyle, seed: string): void {
    const key = `${style}:${seed}`;
    if (key === this.key) return;
    this.key = key;
    this.pending = { style, seed };
    this.fadeOut();
    if (style === "none") return;
    const out = musicOut();
    if (!out) return; // 音が出せるようになったら始める
    const s = STYLES[style];
    const gain = out.ac.createGain();
    gain.gain.setValueAtTime(0, out.ac.currentTime);
    gain.gain.linearRampToValueAtTime(this.idle ? 0.45 : 1, out.ac.currentTime + 1.2);
    gain.connect(out.out);
    this.song = { s, melody: compose(s, seed), gain, next: out.ac.currentTime + 0.15, step: 0 };
    this.timer ??= setInterval(() => this.tick(), 50);
  }

  stop(): void {
    this.key = "";
    this.pending = null;
    this.fadeOut();
  }

  /** 誰も遊んでいないときは小さくする */
  setIdle(idle: boolean): void {
    if (idle === this.idle) return;
    this.idle = idle;
    const out = musicOut();
    if (out && this.song) this.song.gain.gain.setTargetAtTime(idle ? 0.45 : 1, out.ac.currentTime, 0.8);
  }

  private fadeOut(): void {
    const out = musicOut();
    const old = this.song;
    this.song = null;
    if (old && out) {
      old.gain.gain.cancelScheduledValues(out.ac.currentTime);
      old.gain.gain.setTargetAtTime(0, out.ac.currentTime, 0.25);
      setTimeout(() => old.gain.disconnect(), 2000);
    }
  }

  private tick(): void {
    const out = musicOut();
    const song = this.song;
    if (!out || !song) return;
    const { ac } = out;
    const eighth = 60 / song.s.bpm / 2;
    // 画面が隠れていて遅れたときは、まとめて鳴らさず今から続ける
    if (song.next < ac.currentTime - 0.5) song.next = ac.currentTime + 0.05;
    while (song.next < ac.currentTime + 0.25) {
      this.playStep(ac, song.gain, song.s, song.melody, song.step, song.next, eighth);
      song.next += eighth;
      song.step++;
    }
  }

  private playStep(ac: AudioContext, out: GainNode, s: StyleDef, melody: (number | null)[][], step: number, t: number, eighth: number): void {
    const bar = Math.floor(step / 8) % 8;
    const pos = step % 8;
    const chord = s.chords[bar]!;
    const note = (midi: number, len: number, type: OscillatorType, gain: number, attack = 0.01) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type;
      o.frequency.value = freq(midi);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + len + 0.05);
    };

    // 和音（やわらかく、ゆっくり立ち上がる）
    if (pos === 0 && s.pad > 0)
      for (const d of [chord, chord + 2, chord + 4]) note(pitch(s, d, 0), eighth * 8.5, "sine", s.pad, eighth * 2);

    // ベース
    if (s.bass.beats.includes(pos)) note(pitch(s, chord, -2), eighth * 1.8, s.bass.type, s.bass.gain, 0.02);

    // メロディ
    const m = melody[bar]![pos];
    if (m !== null && m !== undefined) note(pitch(s, m, s.lead.octave - 1), eighth * 2 * s.lead.decay + eighth, s.lead.type, s.lead.gain);

    // きらきらした分散和音
    if (s.arp) note(pitch(s, chord + [0, 2, 4, 7][pos % 4]!, 1), eighth * 1.5, "sine", s.arp);

    // 打楽器（小さく）
    if (s.perc === "soft" && (pos === 0 || pos === 4)) this.kick(ac, out, t, 0.25);
    if (s.perc === "soft" && (pos === 2 || pos === 6)) this.shaker(ac, out, t, 0.05);
    if (s.perc === "shaker" && pos % 2 === 1) this.shaker(ac, out, t, 0.035);
    if (s.perc === "taiko" && (pos === 0 || (pos === 3 && bar % 2 === 1) || pos === 6)) this.kick(ac, out, t, pos === 0 ? 0.35 : 0.2, 90);
  }

  private kick(ac: AudioContext, out: GainNode, t: number, gain: number, from = 140): void {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.3);
  }

  private noiseBuf: AudioBuffer | null = null;
  private shaker(ac: AudioContext, out: GainNode, t: number, gain: number): void {
    if (!this.noiseBuf) {
      this.noiseBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.08), ac.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3;
    }
    const src = ac.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ac.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = 6000;
    const g = ac.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(out);
    src.start(t);
  }
}

export const music = new MusicPlayer();
