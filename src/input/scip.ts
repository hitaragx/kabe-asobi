// SCIP 2.0（北陽電機の測域センサの公開通信仕様）のクライアント。
// TCP（既定のポート 10940）で、コマンドを送り、距離データを受け取る。
//
// 応答の形：
//   <コマンドの復唱>\n
//   <状態2文字><チェックサム>\n
//   <データ行（最後の1文字はチェックサム）>\n ...
//   \n（空行で1つの応答が終わる）
// 距離は 1値3文字（6ビット×3）。各文字から 0x30 を引いた値を並べる。

import { Socket, isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import type { Scan, ScanSpec } from "./scan.ts";

export const SCIP_PORT = 10940;

/** チェックサム：行の各文字の和の下位6ビット + 0x30 */
export function checksum(s: string): string {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return String.fromCharCode((sum & 0x3f) + 0x30);
}

/** 6ビット文字列を数値にする */
export function decode(s: string): number {
  let v = 0;
  for (let i = 0; i < s.length; i++) v = (v << 6) | ((s.charCodeAt(i) - 0x30) & 0x3f);
  return v;
}

/** 数値を n 文字の6ビット文字列にする（テスト・模擬サーバー用） */
export function encode(v: number, n: number): string {
  let s = "";
  for (let i = n - 1; i >= 0; i--) s += String.fromCharCode(((v >> (6 * i)) & 0x3f) + 0x30);
  return s;
}

/** データ行のチェックサムを確かめ、最後の1文字を除く */
function stripChecksum(line: string): string {
  const body = line.slice(0, -1);
  if (checksum(body) !== line.slice(-1)) throw new Error(`チェックサムが合いません: ${line.slice(0, 20)}…`);
  return body;
}

export interface ScipResponse {
  echo: string;
  status: string;
  lines: string[];
}

/** 1つの応答（空行までの行の配列）を分解する */
export function parseResponse(block: string[]): ScipResponse {
  const [echo = "", statusLine = "", ...lines] = block;
  // 状態の行は「2文字＋チェックサム」。チェックサムがない機種もあるので2文字だけ見る
  return { echo, status: statusLine.slice(0, 2), lines };
}

/** MD/GD の応答から距離を取り出す（最初のデータ行はタイムスタンプ） */
export function parseDistances(resp: ScipResponse): { timestamp: number; ranges: number[] } {
  const [tsLine, ...data] = resp.lines;
  if (!tsLine) throw new Error("タイムスタンプがありません");
  const timestamp = decode(stripChecksum(tsLine));
  const joined = data.map(stripChecksum).join("");
  if (joined.length % 3 !== 0) throw new Error(`距離データの長さが3の倍数ではありません: ${joined.length}`);
  const ranges = new Array<number>(joined.length / 3);
  for (let i = 0; i < ranges.length; i++) ranges[i] = decode(joined.slice(i * 3, i * 3 + 3));
  return { timestamp, ranges };
}

/** PP（パラメータ）の応答を「名前→値」にする。行は「NAME:値;チェックサム」 */
export function parseParams(resp: ScipResponse): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of resp.lines) {
    const m = line.match(/^([A-Z]+):(.*);.$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** PP の値から機種の仕様を作る */
export function specFromParams(p: Record<string, string>): ScanSpec {
  const n = (k: string) => {
    const v = Number(p[k]);
    if (!Number.isFinite(v)) throw new Error(`パラメータ ${k} がありません`);
    return v;
  };
  const amin = n("AMIN");
  const amax = n("AMAX");
  const ares = n("ARES");
  const rpm = n("SCAN");
  return {
    model: (p.MODL ?? "unknown").split("(")[0]!.trim(),
    // AMIN〜AMAX の点だけを受け取るので、配列の0番は AMIN
    steps: amax - amin + 1,
    frontStep: n("AFRT") - amin,
    angleIncrement: (2 * Math.PI) / ares,
    minRange: n("DMIN"),
    maxRange: n("DMAX"),
    scanPeriodMs: 60000 / rpm,
  };
}

/**
 * センサーにつなぐときに使う、この PC 側の番号を選ぶ。
 * 家の Wi-Fi もセンサーと同じ番号帯（192.168.0.x）だと、通信が Wi-Fi の方へ出てしまい、センサーに届かない。
 * 同じ番号帯の番号が2つ以上あるときは、LAN アダプタに入れる決まりの番号（.100）から送る。
 * 環境変数 KABE_SENSOR_BIND で指定もできる（例：192.168.0.100）。1つしかないときは選ばない（ふつうの経路で届く）
 */
export function pickLocalAddress(host: string): string | undefined {
  const fixed = process.env.KABE_SENSOR_BIND;
  if (fixed) return fixed;
  if (!isIPv4(host)) return undefined;
  const prefix = host.split(".").slice(0, 3).join(".") + ".";
  const same = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal && i.address.startsWith(prefix) && i.address !== host)
    .map((i) => i!.address);
  if (same.length < 2) return undefined;
  return same.find((a) => a.endsWith(".100"));
}

/**
 * SCIP クライアント。
 * command() は1つの応答を待つ。streamMD() は MD コマンドで距離を受け続ける。
 */
export class ScipClient {
  private sock: Socket | null = null;
  private buf = "";
  private block: string[] = [];
  private waiters: { prefix: string; resolve: (r: ScipResponse) => void; reject: (e: Error) => void }[] = [];
  private onScan: ((r: ScipResponse) => void) | null = null;
  onClose: ((err?: Error) => void) | null = null;

  constructor(
    readonly host: string,
    readonly port = SCIP_PORT,
    readonly localAddress: string | undefined = pickLocalAddress(host),
  ) {}

  connect(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = new Socket();
      this.sock = s;
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`センサーにつながりません（${this.host}:${this.port}、${timeoutMs}ms）`));
      }, timeoutMs);
      s.setNoDelay(true);
      // ケーブルを抜かれても気づけるように（OS の keepalive。本命の見張りは LidarSource 側にある）
      s.setKeepAlive(true, 1000);
      let connected = false;
      s.once("connect", () => {
        connected = true;
        clearTimeout(timer);
        resolve();
      });
      // つながる前のエラーは connect() の失敗として返す。つながった後のエラーは close が続くので、そちらで扱う
      s.on("error", (e) => {
        if (connected) return;
        clearTimeout(timer);
        reject(e);
      });
      s.on("data", (d) => this.feed(d.toString("latin1")));
      s.on("close", () => {
        const err = new Error("センサーとの接続が切れました");
        for (const w of this.waiters) w.reject(err);
        this.waiters = [];
        this.onClose?.(err);
      });
      s.connect(this.localAddress ? { port: this.port, host: this.host, localAddress: this.localAddress } : { port: this.port, host: this.host });
    });
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
  }

  private feed(chunk: string): void {
    this.buf += chunk;
    let i = this.buf.indexOf("\n");
    while (i >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (line === "") {
        if (this.block.length) this.dispatch(parseResponse(this.block));
        this.block = [];
      } else {
        this.block.push(line);
      }
      i = this.buf.indexOf("\n");
    }
  }

  private dispatch(r: ScipResponse): void {
    // 距離の流れ（MD の "99" 応答）
    if (r.echo.startsWith("MD") && r.status === "99") {
      this.onScan?.(r);
      return;
    }
    const w = this.waiters.findIndex((x) => r.echo.startsWith(x.prefix));
    if (w >= 0) {
      const [x] = this.waiters.splice(w, 1);
      x!.resolve(r);
    }
  }

  command(cmd: string, timeoutMs = 2000): Promise<ScipResponse> {
    if (!this.sock) return Promise.reject(new Error("つながっていません"));
    return new Promise((resolve, reject) => {
      const prefix = cmd.slice(0, 2);
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x.resolve !== res);
        reject(new Error(`センサーから返事がありません: ${cmd}`));
      }, timeoutMs);
      const res = (r: ScipResponse) => {
        clearTimeout(timer);
        resolve(r);
      };
      this.waiters.push({ prefix, resolve: res, reject });
      this.sock!.write(`${cmd}\n`);
    });
  }

  /** 距離を受け続ける。start〜end の点、毎回（間引きなし）、回数は無限 */
  async streamMD(start: number, end: number, onScan: (ranges: number[], timestamp: number) => void): Promise<void> {
    this.onScan = (r) => {
      try {
        const d = parseDistances(r);
        onScan(d.ranges, d.timestamp);
      } catch {
        // 1回分が壊れていても続ける（次の回で取り戻す）
      }
    };
    const cmd = `MD${String(start).padStart(4, "0")}${String(end).padStart(4, "0")}00000`;
    const r = await this.command(cmd);
    if (r.status !== "00") throw new Error(`MD を受け付けませんでした（状態 ${r.status}）`);
  }
}

/** 距離の値をそろえる：測れない値・範囲外は 0 にする */
export function cleanRanges(ranges: number[], spec: ScanSpec): number[] {
  return ranges.map((v) => (v < spec.minRange || v > spec.maxRange ? 0 : v));
}

export type { Scan };
