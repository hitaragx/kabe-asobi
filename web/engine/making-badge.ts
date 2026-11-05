// 壁の左下に出す「つぎの あそびを つくってるよ」。
// 職員が新しい遊びを頼んで、Claude が作っている間に出す。いまの遊びはそのまま遊べる。
// できたら「できた！」を少し見せて消す。

import { type Application, Container, Graphics, Text } from "pixi.js";
import { fontFamily, lineWidth, palette } from "./style.ts";

/** 知らせが来なくなっても、出しっぱなしにしない */
const MAX_SHOW_MS = 6 * 60 * 1000;

export class MakingBadge {
  private root = new Container();
  private box = new Graphics();
  private dots = new Graphics();
  private label: Text;
  private state: "hidden" | "making" | "done" = "hidden";
  private time = 0;
  private stateTime = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly app: Application) {
    this.label = new Text({ text: "", style: { fontFamily, fontWeight: "900", fill: palette.ink, lineHeight: 0, align: "left" } });
    this.root.addChild(this.box, this.dots, this.label);
    this.root.visible = false;
    app.stage.addChild(this.root);
    app.ticker.add((t) => {
      this.time += t.deltaMS;
      this.stateTime += t.deltaMS;
      if (this.state !== "hidden") this.draw();
    });
  }

  get current(): "hidden" | "making" | "done" {
    return this.state;
  }

  set(next: "start" | "done" | "off"): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (next === "off") {
      this.state = "hidden";
      this.root.visible = false;
      return;
    }
    this.state = next === "start" ? "making" : "done";
    this.stateTime = 0;
    this.root.visible = true;
    this.timer = setTimeout(() => this.set("off"), next === "start" ? MAX_SHOW_MS : 3000);
    this.draw();
  }

  private draw(): void {
    const { width: W, height: H } = this.app.screen;
    const u = H / 100;
    // いちばん上に出す（遊びを切り替えても隠れない）
    if (this.app.stage.children.at(-1) !== this.root) this.app.stage.addChild(this.root);
    const making = this.state === "making";
    // 遊びの邪魔にならないよう、2行にして幅を詰める
    this.label.text = making ? "つぎの あそびを\nつくってるよ" : "できた！";
    this.label.style.fontSize = (making ? 3.8 : 5.5) * u;
    this.label.style.lineHeight = (making ? 3.8 : 5.5) * u * 1.3;
    const dotsW = making ? 10.5 * u : 0;
    const padX = 3 * u;
    const h = this.label.height + (making ? 3 : 4) * u;
    const w = this.label.width + dotsW + padX * 2;
    const x = 2.5 * u;
    // 点数は上に、センサーの知らせは右下に出るので、左下の角に出す
    const y = H - h - 2.5 * u;

    // 出てくるときは、少しはずむ
    const pop = Math.min(1, this.stateTime / 250);
    const s = 0.6 + 0.4 * (1 - (1 - pop) ** 3) + (making ? 0 : Math.sin(Math.min(1, this.stateTime / 400) * Math.PI) * 0.12);
    this.root.pivot.set(x + w / 2, y + h / 2);
    this.root.position.set(x + w / 2, y + h / 2);
    this.root.scale.set(s);

    this.box
      .clear()
      .roundRect(x, y, w, h, Math.min(h / 2, 5 * u))
      .fill(making ? palette.white : palette.yellow)
      .stroke({ width: lineWidth(H), color: palette.ink });
    this.label.anchor.set(0, 0.5);
    this.label.position.set(x + padX, y + h / 2);

    // 作っている間は、3つの丸が順にはねる
    this.dots.clear();
    if (making) {
      const cx = x + padX + this.label.width + 3.2 * u;
      const colors = [palette.red, palette.yellow, palette.blue];
      for (let i = 0; i < 3; i++) {
        const jump = Math.max(0, Math.sin(this.time / 220 - i * 0.9)) * 1.4 * u;
        this.dots
          .circle(cx + i * 2.6 * u, y + h / 2 - jump, 1 * u)
          .fill(colors[i]!)
          .stroke({ width: Math.max(2, lineWidth(H) * 0.5), color: palette.ink });
      }
    }
  }
}
