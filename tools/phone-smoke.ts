// スマホ画面の通し確認（仮の相手）。
// ハブ・壁の画面・スマホ画面のサーバーを起動し、スマホの大きさの画面で操作して、壁が変わるかを見る。
//   npx tsx tools/phone-smoke.ts

import { type ChildProcess, spawn } from "node:child_process";
import { chromium } from "playwright";

const procs: ChildProcess[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUp(url: string) {
  for (let i = 0; i < 75; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await wait(200);
  }
  throw new Error(`起動しません: ${url}`);
}
const KEY = "smoketest";
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "NG  "} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};
const wallParams = async () => {
  const r = await fetch("http://127.0.0.1:8787/api/status").then((x) => x.json());
  return r.params as Record<string, Record<string, unknown>>;
};

const startedAt = Date.now();
try {
  procs.push(spawn("npx", ["tsx", "src/server/hub.ts", "--source", "sim"], { stdio: "ignore" }));
  procs.push(spawn("npx", ["vite", "--port", "5173", "--strictPort"], { stdio: "ignore" }));
  procs.push(spawn("npx", ["tsx", "src/server/phone.ts", "--mock", "--key", KEY], { stdio: "ignore" }));
  await waitUp("http://127.0.0.1:8787");
  await waitUp("http://127.0.0.1:5173");
  await waitUp("http://127.0.0.1:8790");
  await fetch("http://127.0.0.1:8787/api/params/reset", { method: "POST", body: JSON.stringify({ id: "balloons" }) });

  const browser = await chromium.launch();
  const wallPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await wallPage.goto("http://127.0.0.1:5173/?muted&game=balloons");
  await wait(1500);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const phone = await ctx.newPage();
  const errors: string[] = [];
  phone.on("pageerror", (e) => errors.push(e.message));

  // 合言葉なしでは開けない
  const denied = await fetch("http://127.0.0.1:8790/").then((r) => r.status);
  check("合言葉なしでは開けない", denied === 403, denied);

  await phone.goto(`http://127.0.0.1:8790/?k=${KEY}`);
  await wait(2500);
  check("壁の画面が映る", await phone.evaluate(() => (document.getElementById("wall-img") as HTMLImageElement).naturalWidth > 0));
  check("いまの遊びの名前", (await phone.textContent("#wall-title")) === "ふうせんわり", await phone.textContent("#wall-title"));
  check("はじめは頼み方の例が出る", (await phone.locator(".examples button").count()) === 4, await phone.locator(".examples button").count());
  await phone.screenshot({ path: "test-results/phone-1-start.png" });

  // 頼み方の例を押す → 作る前に案が出る（まだ作らない）
  await phone.click(".examples button >> nth=0");
  await phone.waitForSelector(".plan .row button.primary", { timeout: 10000 });
  check("新しい遊びは、作る前に案が出る", (await phone.locator(".plan h3").count()) === 1);
  await phone.screenshot({ path: "test-results/phone-2-plan.png" });
  // 「これで作って」→ 作り始め、壁に「つくってるよ」が出る
  await phone.click(".plan .row button.primary");
  await wait(600);
  const makingNow = await wallPage.evaluate(() => (window as any).__kabe.stats().making);
  check("作っている間、壁に「つくってるよ」が出る", makingNow === "making", makingNow);
  await wallPage.screenshot({ path: "test-results/phone-wall-making.png" });
  await phone.waitForSelector("#send:not(.stop)", { timeout: 15000 });
  await wait(300);
  check("返事のあとは、案のボタンが消える", !(await phone.locator(".plan .row").isVisible()));
  const makingAfter = await wallPage.evaluate(() => (window as any).__kabe.stats().making);
  check("終わったら壁の表示が消える（仮の相手は遊びを出さない）", makingAfter === "hidden", makingAfter);
  await phone.screenshot({ path: "test-results/phone-3-made.png" });

  // よく使う頼みごと：「もっと大きく」→ 案は出さずに、すぐ壁の値が変わる
  await phone.click("text=もっと大きく");
  await phone.waitForSelector("#send:not(.stop)", { timeout: 10000 });
  await wait(500);
  const p = await wallParams();
  check("「もっと大きく」で壁の値が変わる", Number(p.balloons?.size) > 1, p.balloons);
  await phone.screenshot({ path: "test-results/phone-4-bigger.png" });

  // 文字で頼む → 案が出る。「なおしたい」で直す言葉を入れられる
  await phone.fill("#text", "節分だから、鬼にボールを当てる遊びを作って");
  await phone.click("#send");
  await phone.waitForSelector("#send:not(.stop)", { timeout: 15000 });
  check("前の案は押せず、新しい案だけ押せる", (await phone.locator(".plan").count()) === 2 && (await phone.locator(".plan .row:not([hidden])").count()) === 1);
  await phone.click(".plan .row:not([hidden]) button:first-child");
  check("「なおしたい」で入力に移る", await phone.evaluate(() => document.activeElement?.id === "text"));

  // 遊びをえらぶ
  await phone.click("#btn-games");
  await phone.waitForSelector(".game");
  await phone.screenshot({ path: "test-results/phone-5-games.png" });
  // 名前を押すと、くわしいこと（作った日・頼みごと・理由）が開く
  await phone.click('.game:has-text("どうぶつ おんがくたい") > div');
  await phone.waitForSelector(".detail");
  check("遊びのくわしいことが開く", (await phone.textContent(".detail h3")) === "どうぶつ おんがくたい", await phone.textContent(".detail h3"));
  await phone.click(".detail .actions-row button:first-child"); // もどる
  await phone.click('.game:has-text("どうぶつ おんがくたい") .go');
  await wait(1500);
  check("遊びを切り替えられる", (await phone.textContent("#wall-title")) === "どうぶつ おんがくたい", await phone.textContent("#wall-title"));

  // そのほか → きろく
  await phone.click("#btn-more");
  await phone.waitForSelector(".menu");
  await phone.screenshot({ path: "test-results/phone-6-more.png" });
  await phone.click('.menu button:has-text("きろく")');
  await phone.waitForSelector(".req, .empty");
  check("きろくが開く", (await phone.locator(".req").count()) >= 1, await phone.locator(".req").count());
  const reqs = ((await (await phone.request.get("http://127.0.0.1:8790/api/requests")).json()) as { at: number; request: string }[]).filter((r) => r.at >= startedAt);
  check("きろくには、「この案で作って」ではなく元の頼みごとが残る", reqs.some((r) => r.request.startsWith("4歳くらい")) && !reqs.some((r) => r.request === "この案で作って"), reqs.map((r) => r.request));
  check("案を見せただけの頼みごとは、きろくに残らない", !reqs.some((r) => r.request.startsWith("節分だから")), reqs.map((r) => r.request));
  await phone.click("#sheet-close");

  // おと：音楽を1つ小さくすると、ハブに保存される
  const before = (await (await fetch("http://127.0.0.1:8787/api/status")).json()).audio.music as number;
  await phone.click("#btn-more");
  await phone.click('.menu button:has-text("おと")');
  await phone.waitForSelector(".vol");
  await phone.click(".vol .row button:first-child");
  await wait(800);
  const after = (await (await fetch("http://127.0.0.1:8787/api/status")).json()).audio.music as number;
  check("おとで音楽の大きさが変わる", after === Math.max(0, before - 1), { before, after });
  await phone.click(".vol .row button:last-child");
  await wait(800);
  await phone.click("#sheet-close");

  // 戻す
  await phone.click("#btn-back");
  await wait(1500);
  check("さっきのに戻す", (await phone.textContent("#wall-title")) === "ふうせんわり", await phone.textContent("#wall-title"));

  // 開き直しても会話が残る
  await phone.reload();
  await wait(1500);
  check("開き直しても会話が残る", (await phone.locator(".msg").count()) >= 4, await phone.locator(".msg").count());
  check("開き直しても、待っている案は押せる", (await phone.locator(".plan .row:not([hidden])").count()) === 1);
  check("画面のエラーなし", errors.length === 0, errors);

  await browser.close();
} finally {
  await fetch("http://127.0.0.1:8787/api/params/reset", { method: "POST", body: JSON.stringify({ id: "balloons" }) }).catch(() => {});
  for (const p of procs) p.kill("SIGTERM");
  console.log(failures === 0 ? "すべて合格" : `${failures} 件 不合格`);
  process.exitCode = failures === 0 ? 0 : 1;
}
