// 合わせ込みの表示：番号つきの丸、押さえている進み具合、案内の文字。
// 合わせ込みの間は遊びを隠す（タッチで遊びが反応しないように）。

import { type Application, Container, Graphics, Text } from "pixi.js";
import type { CalibView } from "../../src/shared/protocol.ts";
import { fontFamily, palette } from "./style.ts";

export class CalibrationView {
  private root = new Container();
  private time = 0;
  private view: CalibView | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly app: Application,
    private readonly gameLayers: Container[],
  ) {
    app.stage.addChild(this.root);
    app.ticker.add((t) => {
      this.time += t.deltaMS;
      if (this.view) this.draw();
    });
  }

  get showing(): boolean {
    return this.view !== null;
  }

  set(view: CalibView | null): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.view = view;
    // いちばん上に出す
    this.app.stage.addChild(this.root);
    for (const l of this.gameLayers) l.visible = view === null;
    if (!view) {
      this.clear();
      return;
    }
    this.draw();
    if (view.phase === "done" || view.phase === "failed") {
      // 結果を少し見せてから、遊びに戻す
      this.hideTimer = setTimeout(() => this.set(null), view.phase === "done" ? 3000 : 6000);
    }
  }

  private clear(): void {
    for (const c of this.root.removeChildren()) c.destroy({ children: true });
  }

  private text(s: string, size: number, color: number = palette.white): Text {
    const u = this.app.screen.height / 100;
    const t = new Text({ text: s, style: { fontFamily, fontSize: size * u, fontWeight: "900", fill: color, stroke: { color: palette.ink, width: u * 0.8 }, align: "center" } });
    t.anchor.set(0.5);
    return t;
  }

  private draw(): void {
    const v = this.view!;
    const { width: W, height: H } = this.app.screen;
    const u = H / 100;
    this.clear();
    this.root.addChild(new Graphics().rect(0, 0, W, H).fill(0x101426));

    v.targets.forEach((tg, i) => {
      const x = tg.x * W;
      const y = tg.y * H;
      const isActive = i === v.active && (v.phase === "collect" || v.phase === "check");
      const done = v.captured[i];
      const g = new Graphics();
      const R = u * 5;
      if (isActive) {
        const pulse = 1 + Math.sin(this.time / 200) * 0.12;
        g.circle(x, y, R * 1.8 * pulse).fill({ color: palette.yellow, alpha: 0.25 });
        g.circle(x, y, R).fill(palette.yellow).stroke({ width: u * 0.8, color: palette.white });
        if (v.holdProgress > 0) {
          // 押さえている進み具合（円の周り）。前の図形と線がつながらないよう、始点に移ってから描く
          const a0 = -Math.PI / 2;
          g.moveTo(x + Math.cos(a0) * R * 1.4, y + Math.sin(a0) * R * 1.4)
            .arc(x, y, R * 1.4, a0, a0 + Math.PI * 2 * v.holdProgress)
            .stroke({ width: u * 1.2, color: palette.green, cap: "round" });
        }
      } else if (done) {
        g.circle(x, y, R * 0.8).fill(palette.green).stroke({ width: u * 0.5, color: palette.white });
      } else {
        g.circle(x, y, R * 0.7).stroke({ width: u * 0.4, color: tg.check ? palette.blue : palette.white, alpha: 0.5 });
      }
      this.root.addChild(g);
      const label = this.text(done && !isActive ? "✓" : tg.check ? "?" : String(i + 1), isActive ? 5 : 3.5, isActive ? palette.ink : palette.white);
      if (isActive) label.style.stroke = { color: palette.yellow, width: 0 };
      label.x = x;
      label.y = y;
      this.root.addChild(label);
    });

    const msgColor = v.phase === "done" ? palette.green : v.phase === "failed" ? palette.orange : palette.white;
    const msg = this.text(v.message, 5, msgColor);
    msg.x = W / 2;
    // 案内の文字は、丸と重ならない高さに出す（横に長いので、中央寄りの丸を避ける）
    const ys = v.targets.filter((t) => Math.abs(t.x - 0.5) < 0.45).map((t) => t.y);
    const best = [0.3, 0.4, 0.6, 0.2].reduce((a, c) => (Math.min(...ys.map((y) => Math.abs(y - c))) > Math.min(...ys.map((y) => Math.abs(y - a))) ? c : a));
    msg.y = H * best;
    this.root.addChild(msg);
  }
}
