// 壁の入力：ハブからの WebSocket と、マウス・タッチ（開発用の模擬入力）をまとめる。
// 座標はピクセルに直して渡す。

import { type ClientMessage, HUB_PORT, type HubMessage, type WallAction, type WallPoint } from "../../src/shared/protocol.ts";

export interface Hit {
  id: number;
  /** 画面のピクセル座標 */
  x: number;
  y: number;
  source: string;
  /** センサーが取得した時刻（Unixミリ秒）。遅延の計測に使う */
  t: number;
  /** ハブが送り出した時刻（Unixミリ秒） */
  tSent?: number;
}

/** 1回の「当たり」の遅れの内訳（ミリ秒） */
export interface LatencySample {
  /** スキャン受信 → ハブが送り出すまで（当たり検出・座標変換） */
  hub: number;
  /** ハブ → ブラウザの遊びに届くまで（WebSocket） */
  net: number;
  /** 遊びに届く → 反応を描いた画面ができるまで（次の描画） */
  frame: number;
  /** スキャン受信 → 画面ができるまでの合計 */
  total: number;
}

export type SensorStatus = "connecting" | "starting" | "ok" | "lost";

type Listener<T> = (v: T) => void;

export class WallInput {
  status: SensorStatus = "connecting";
  /** いま壁に触れている点（ピクセル座標） */
  points: (WallPoint & { px: number; py: number })[] = [];
  lastInputAt = performance.now();
  /** 遅延（ミリ秒、スキャン受信 → 遊びに届く）の直近の記録 */
  latencies: number[] = [];
  /** 遅れの内訳の直近の記録 */
  latencySamples: LatencySample[] = [];

  private downL = new Set<Listener<Hit>>();
  private upL = new Set<Listener<Hit>>();
  private statusL = new Set<Listener<SensorStatus>>();
  private ws: WebSocket | null = null;
  private mouseId = -1;
  /** 壁サーバーからの操作を受ける */
  controlHandler: ((a: WallAction) => Promise<unknown> | unknown) | null = null;

  constructor(
    private readonly size: () => { width: number; height: number },
    private readonly el: HTMLElement,
    /** wall＝壁に映す画面、draft＝検証用の画面（操作は受けない） */
    private readonly role: "wall" | "draft" = "wall",
  ) {
    this.connect();
    this.bindMouse();
  }

  onDown(f: Listener<Hit>): () => void {
    this.downL.add(f);
    return () => this.downL.delete(f);
  }
  onUp(f: Listener<Hit>): () => void {
    this.upL.add(f);
    return () => this.upL.delete(f);
  }
  onStatus(f: Listener<SensorStatus>): () => void {
    this.statusL.add(f);
    return () => this.statusL.delete(f);
  }

  /** 検証などからの模擬入力（正規化座標） */
  inject(x: number, y: number, source = "inject"): void {
    const { width, height } = this.size();
    const id = this.mouseId--;
    const hit = { id, x: x * width, y: y * height, source, t: Date.now() };
    this.emitDown(hit);
    setTimeout(() => this.emitUp(hit), 50);
  }

  private setStatus(s: SensorStatus): void {
    if (s === this.status) return;
    this.status = s;
    for (const f of this.statusL) f(s);
  }

  private emitDown(h: Hit): void {
    this.lastInputAt = performance.now();
    if (h.source !== "mouse" && h.source !== "inject") {
      const now = Date.now();
      this.latencies.push(now - h.t);
      if (this.latencies.length > 100) this.latencies.shift();
      // 反応を描いた画面ができる時刻は、次の描画の呼び出しで測る（PixiJS も同じ呼び出しで描く）
      requestAnimationFrame(() => {
        const painted = Date.now();
        const sent = h.tSent ?? h.t;
        this.latencySamples.push({ hub: sent - h.t, net: now - sent, frame: painted - now, total: painted - h.t });
        if (this.latencySamples.length > 200) this.latencySamples.shift();
      });
    }
    for (const f of this.downL) f(h);
  }
  private emitUp(h: Hit): void {
    for (const f of this.upL) f(h);
  }

  private connect(): void {
    const url = `ws://${location.hostname || "127.0.0.1"}:${HUB_PORT}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    const send = (m: ClientMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    ws.onopen = () => send({ kind: "hello", role: this.role });
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as HubMessage;
      if (m.kind === "control") {
        const { kind: _k, reqId, ...action } = m;
        Promise.resolve()
          .then(() => {
            if (!this.controlHandler) throw new Error("操作を受け付けていません");
            return this.controlHandler(action as WallAction);
          })
          .then(
            (data) => send({ kind: "reply", reqId, ok: true, data }),
            (e: unknown) => send({ kind: "reply", reqId, ok: false, error: e instanceof Error ? e.message : String(e) }),
          );
        return;
      }
      if (m.kind === "status") {
        this.setStatus(m.sensor);
        return;
      }
      this.setStatus("ok");
      const { width, height } = this.size();
      const f = m.frame;
      this.points = f.points.map((p) => ({ ...p, px: p.x * width, py: p.y * height }));
      for (const e of f.events) {
        const hit = { id: e.id, x: e.x * width, y: e.y * height, source: f.source, t: f.t_capture, tSent: f.t_sent };
        if (e.type === "down") this.emitDown(hit);
        else this.emitUp(hit);
      }
    };
    ws.onclose = () => {
      // ハブが止まっても画面は固まらず、待機に戻って再接続を続ける
      this.points = [];
      this.setStatus("lost");
      setTimeout(() => this.connect(), 1000);
    };
  }

  private bindMouse(): void {
    this.el.addEventListener("pointerdown", (e) => {
      const id = this.mouseId--;
      const hit = { id, x: e.offsetX, y: e.offsetY, source: "mouse", t: Date.now() };
      this.emitDown(hit);
      const up = () => {
        this.emitUp(hit);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointerup", up);
    });
  }

  close(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
  }
}
