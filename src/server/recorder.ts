// 生のスキャンを JSON Lines で記録する。1行目はヘッダー。
// 記録にはコンピュータ名・ユーザー名・パス・ネットワーク情報を入れない。

import { type WriteStream, createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Scan } from "../input/scan.ts";
import type { RecordingHeader } from "./sources.ts";

export class Recorder {
  private out: WriteStream;
  count = 0;

  constructor(file: string, header: Omit<RecordingHeader, "type" | "version">) {
    mkdirSync(dirname(file), { recursive: true });
    this.out = createWriteStream(file);
    const h: RecordingHeader = { type: "header", version: 1, ...header };
    this.out.write(`${JSON.stringify(h)}\n`);
  }

  write(scan: Scan): void {
    this.out.write(`${JSON.stringify({ seq: scan.seq, t: scan.t, ranges: scan.ranges })}\n`);
    this.count++;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.out.end(resolve));
  }
}
