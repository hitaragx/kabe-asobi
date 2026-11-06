// 編集の後（PostToolUse）。web/games/ の遊びを書き換えたら型チェックを走らせ、
// 失敗したらその内容を Claude に返す（直してから verify_game へ進めるように）。
import { execFile } from "node:child_process";
import { join } from "node:path";

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  // Windows のパス（\ 区切り）も同じに見る
  const p = String(input.tool_input?.file_path ?? input.tool_response?.filePath ?? "").replaceAll("\\", "/");
  if (!/(^|\/)web\/(games|engine)\/[^/]+\.ts$/.test(p)) process.exit(0);
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // npx を通さずに node で直接動かす（Windows でも動くように）
  execFile(process.execPath, [join(cwd, "node_modules/typescript/bin/tsc"), "--noEmit", "--pretty", "false"], { cwd, timeout: 60000 }, (err, stdout, stderr) => {
    if (!err) {
      const out = {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: /web\/games\//.test(p) ? "型チェックは通りました。壁に出す前に verify_game で確かめてください。" : "型チェックは通りました。",
        },
      };
      process.stdout.write(JSON.stringify(out));
      process.exit(0);
    }
    const lines = `${stdout}${stderr}`.split("\n").filter((l) => l.trim()).slice(0, 20).join("\n");
    process.stdout.write(JSON.stringify({ decision: "block", reason: `型チェックで問題が見つかりました。直してください：\n${lines}` }));
    process.exit(0);
  });
});
