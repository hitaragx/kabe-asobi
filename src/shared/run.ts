// 道具（tsx・vite・tsc）を、npx を通さずに node で直接動かす。
// Windows では npx が npx.cmd なので、そのままでは子プロセスとして起動できない（シェルを通すと、止めるときに孫が残る）。
// node で直接動かせば、Mac でも Windows でも同じように起動・停止できる。

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** リポジトリの一番上 */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const BIN = {
  tsx: "node_modules/tsx/dist/cli.mjs",
  vite: "node_modules/vite/bin/vite.js",
  tsc: "node_modules/typescript/bin/tsc",
} as const;

/** spawn / execFile に渡す [コマンド, 引数] */
export function tool(name: keyof typeof BIN, args: string[]): [string, string[]] {
  return [process.execPath, [join(ROOT, BIN[name]), ...args]];
}

/** MCP の StdioClientTransport に渡す形 */
export function toolStdio(name: keyof typeof BIN, args: string[]): { command: string; args: string[] } {
  const [command, a] = tool(name, args);
  return { command, args: a };
}
