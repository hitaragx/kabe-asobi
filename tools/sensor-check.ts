// センサーの接続確認。つながるか、仕様、1回分の距離の様子を表示する。
//   npx tsx tools/sensor-check.ts [--host 192.168.0.10]
import { networkInterfaces } from "node:os";
import { parseArgs } from "node:util";
import { SCIP_PORT, ScipClient, parseDistances, parseParams, specFromParams } from "../src/input/scip.ts";

const { values } = parseArgs({ options: { host: { type: "string", default: "192.168.0.10" }, port: { type: "string", default: String(SCIP_PORT) } } });
const c = new ScipClient(values.host!, Number(values.port));
const say = (s: string) => console.log(s);

try {
  say(`1. ${values.host}:${values.port} につなぎます…${c.localAddress ? `（この PC の ${c.localAddress} から）` : ""}`);
  await c.connect(3000);
  say("   つながりました");
  const vv = await c.command("VV");
  say("2. センサーの情報");
  for (const l of vv.lines) say(`   ${l.slice(0, -2)}`);
  const spec = specFromParams(parseParams(await c.command("PP")));
  say(`3. 仕様：${spec.model}、${spec.steps}点、1点 ${((spec.angleIncrement * 180) / Math.PI).toFixed(3)}°、1回 ${spec.scanPeriodMs.toFixed(1)}ms、${spec.minRange}〜${spec.maxRange}mm`);
  // GD の前にレーザーを点ける（MD は自動で点くが、GD は点けておく必要がある）
  await c.command("BM");
  const gd = await c.command(`GD0000${String(spec.steps - 1).padStart(4, "0")}00`, 3000);
  if (gd.status !== "00") throw new Error(`距離の取得に失敗しました（状態 ${gd.status}）。もう一度試してください`);
  const { ranges } = parseDistances(gd);
  const valid = ranges.filter((r) => r >= spec.minRange && r <= spec.maxRange);
  const near = Math.min(...valid);
  say(`4. 距離：${ranges.length}点中 ${valid.length}点が測れました（${((valid.length / ranges.length) * 100).toFixed(0)}%）。いちばん近い物まで ${near}mm、正面 ${ranges[spec.frontStep]}mm`);
  if (valid.length / ranges.length < 0.3) say("   ※ 測れた点が少ないです。センサーの前に物を置くか、向きを確かめてください");
  await c.command("QT");
  say("\n合格：センサーとの通信は問題ありません");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  say(`\n不合格：${msg}`);
  // この PC 自身がセンサーと同じ IP を持っていると、ping は自分に返事をして通ってしまう（家の Wi-Fi が 192.168.0.x のとき）
  const mine = Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).filter((i) => i.family === "IPv4" && i.address === values.host).map(() => name),
  );
  if (mine.length) {
    say(`\n※ この PC 自身（${mine.join("・")}）が ${values.host} を使っています。ping が通っても、センサーではなく自分が返事をしています。`);
    say("   docs/sensor-setup.md の「Wi-Fi も 192.168.0.x のとき」の手順で、Wi-Fi の番号を変えてください");
  }
  say("確かめること：");
  say("  - センサーの電源が入っているか（青いランプが点きっぱなし）、LANケーブルがささっているか");
  say("  - Mac の有線LANの IP が 192.168.0.100、サブネットマスク 255.255.255.0、ルーターが空欄か");
  say(`  - ping -c 3 ${values.host} で返事があるか。なければ、センサーの IP アドレスが変わっている可能性があります（docs/sensor-setup.md）`);
  process.exitCode = 1;
} finally {
  c.close();
}
