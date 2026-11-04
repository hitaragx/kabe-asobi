import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkRequest, noteVersion, readMeta } from "../src/server/games.ts";

describe("遊びの記録（作った日・頼みごと・理由）", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kabe-meta-"));
    process.env.KABE_GAMES_META = join(dir, "meta.json");
  });
  afterEach(() => {
    delete process.env.KABE_GAMES_META;
    rmSync(dir, { recursive: true, force: true });
  });

  it("壁に出すたびに版が増え、作った日は最初のまま", async () => {
    noteVersion("oni", { kind: "new", reason: "4歳なので勝ち負けなし" });
    const first = readMeta().oni!.createdAt;
    await new Promise((r) => setTimeout(r, 5));
    noteVersion("oni", { kind: "update", reason: "大きくした" });
    const m = readMeta().oni!;
    expect(m.createdAt).toBe(first);
    expect(m.updatedAt).toBeGreaterThan(first);
    expect(m.versions.map((v) => v.kind)).toEqual(["new", "update"]);
  });

  it("頼みごとは、その作業中に出た版にだけ結びつく", async () => {
    noteVersion("old", { kind: "new" });
    await new Promise((r) => setTimeout(r, 5));
    const since = Date.now();
    noteVersion("oni", { kind: "new", reason: "理由" });
    expect(linkRequest(since, "鬼の遊びを作って")).toEqual([{ id: "oni", kind: "new" }]);
    const m = readMeta();
    expect(m.oni!.versions[0]!.request).toBe("鬼の遊びを作って");
    expect(m.old!.versions[0]!.request).toBeUndefined();
    // 2回目は結びつけ済みなので何もしない
    expect(linkRequest(since, "別の頼みごと")).toEqual([]);
  });
});
