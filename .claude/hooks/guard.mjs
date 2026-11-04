// 実行前の見張り（PreToolUse）。止めるときは理由を stderr に書いて終了コード 2。
// - web/live/ の直接編集：壁の版は publish_game（検証つき）でだけ更新する
// - 危ない操作：force push、rm -rf、git reset --hard、git clean -f など
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};
  const block = (msg) => {
    process.stderr.write(msg);
    process.exit(2);
  };

  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const p = String(ti.file_path ?? ti.notebook_path ?? "");
    if (/(^|\/)web\/live\//.test(p)) {
      block("web/live/ は壁に映っている版なので、直接は編集しません。web/games/ の下書きを直し、verify_game で確かめてから publish_game で壁に出してください。");
    }
  }

  if (tool === "Bash") {
    const cmd = String(ti.command ?? "");
    const rules = [
      [/\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|\s--force-with-lease\b)/, "force push は禁止です"],
      // コマンドとして実行される rm だけを見る（行の先頭か ; && || | の後）。文章の中の「rm -rf」には反応しない
      [/(^|\n|[;&|]\s*)\s*(sudo\s+)?rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, "rm -rf は禁止です。消す必要があるなら、対象を1つずつ確かめて消してください"],
      [/\bgit\s+reset\s+--hard\b/, "git reset --hard は禁止です（作業が消えます）"],
      [/\bgit\s+clean\s+-[a-zA-Z]*f/, "git clean -f は禁止です（記録データなどが消えます）"],
      [/\bgit\s+branch\s+-D\b/, "ブランチの強制削除は禁止です"],
      [/(^|[\s;&|])(cp|mv|tee)\b[^\n]*\sweb\/live\//, "web/live/ へは publish_game でだけ書き込みます"],
      [/>\s*web\/live\//, "web/live/ へは publish_game でだけ書き込みます"],
    ];
    for (const [re, msg] of rules) if (re.test(cmd)) block(`止めました：${msg}\nコマンド：${cmd.slice(0, 200)}`);
  }
  process.exit(0);
});
