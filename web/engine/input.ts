// 壁の入力：ハブからの WebSocket と、マウス・タッチ（開発用の模擬入力）をまとめる。
// 座標はピクセルに直して渡す。

import { HUB_PORT, type HubMessage, type WallPoint } from "../../src/shared/protocol.ts";

export interface Hit {
  id: number;
  /** 画面のピクセル座標 */
  x: number;
  y: number;
  source: string;
  /** センサーが取得した時刻（Unixミリ秒）。遅延の計測に使う */
  t: number;
}

export type SensorStatus = "connecting" | "starting" | "ok" | "lost";

type Listener<T> = (v: T) => void;

export class WallInput {
  status: SensorStatus = "connecting";
  /** いま壁に触れている点（ピクセル座標） */
  points: (WallPoint & { px: number; py: number })[] = [];
  lastInputAt = performance.now();
  /** 遅延（ミリ秒）の直近の記録 */
  latencies: number[] = [];

  private downL = new Set<Listener<Hit>>();
  private upL = new Set<Listener<Hit>>();
  private statusL = new Set<Listener<SensorStatus>>();
  private ws: WebSocket | null = null;
  private mouseId = -1;

  constructor(
    private readonly size: () => { width: number; height: number },
    private readonly el: HTMLElement,
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
      this.latencies.push(Date.now() - h.t);
      if (this.latencies.length > 100) this.latencies.shift();
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
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as HubMessage;
      if (m.kind === "status") {
        this.setStatus(m.sensor);
        return;
      }
      this.setStatus("ok");
      const { width, height } = this.size();
      const f = m.frame;
      this.points = f.points.map((p) => ({ ...p, px: p.x * width, py: p.y * height }));
      for (const e of f.events) {
        const hit = { id: e.id, x: e.x * width, y: e.y * height, source: f.source, t: f.t_capture };
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
