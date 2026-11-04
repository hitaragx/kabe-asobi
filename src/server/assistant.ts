// 職員の頼みごとを受けて、Claude Code（Agent SDK）に遊びを作らせる・直させる。
// - ClaudeAssistant：本物。プロジェクトの CLAUDE.md・Skills・サブエージェント・フック・壁サーバーをそのまま使う
// - MockAssistant：APIキーがないとき用の仮の相手。画面の流れを作るために使う
//
// 認証は APIキー（ANTHROPIC_API_KEY）。職員が使う画面なので、claude.ai のログインは使わない（Agent SDK の利用規定）。

import { query } from "@anthropic-ai/claude-agent-sdk";
import { HUB_PORT } from "../shared/protocol.ts";

/** 画面に送る出来事 */
export type AssistantEvent =
  /** 何をしているか（短い一言。コードは見せない） */
  | { type: "step"; text: string }
  /** 返事の文字（少しずつ届く） */
  | { type: "text"; delta: string }
  | { type: "done"; text: string; costUsd?: number; seconds: number }
  | { type: "error"; message: string };

export interface Assistant {
  readonly kind: "claude" | "mock";
  send(prompt: string, emit: (e: AssistantEvent) => void, signal: AbortSignal): Promise<void>;
  /** 新しい会話にする */
  reset(): void;
}

/** 職員向けの話し方と、使ってよい範囲 */
const STAFF_MODE = `
# 職員モード
いま話しかけているのは、児童館などの職員（エンジニアではない）。スマホの専用画面から話しかけている。
- 返事は日本語で2〜3行。専門用語（コード、ファイル、パラメータ、デプロイ、エラーの中身）は使わない
- 遊びを作る・変えるときは new-game スキル、遊んでいる最中の調整は tune スキル、壁への合わせ込みは calibrate スキルの手順に従う
- 壁に出す前に必ず verify_game で確かめ、壁に出すのは publish_game だけ
- 「大きく」「ゆっくり」など params で済むものは set_params で直す
- 終わったら、何を変えたかを一言で伝え、「どうですか？」と聞く
- 分からないことは推測で大きく作り変えず、1問だけ聞く
`.trim();

/** 道具の名前 → 職員に見せる一言 */
function stepText(tool: string): string | null {
  const map: Record<string, string> = {
    mcp__wall__verify_game: "遊びを確かめています",
    mcp__wall__publish_game: "壁に出しています",
    mcp__wall__rollback_game: "前の版に戻しています",
    mcp__wall__previous_game: "前の遊びに戻しています",
    mcp__wall__show_game: "遊びを切り替えています",
    mcp__wall__set_params: "調整しています",
    mcp__wall__reset_params: "元の設定に戻しています",
    mcp__wall__wall_screenshot: "壁を見ています",
    mcp__wall__wall_status: "壁の様子を見ています",
    mcp__wall__list_games: "遊びの一覧を見ています",
    mcp__wall__calibrate_start: "壁に合わせる準備をしています",
    mcp__wall__calibrate_status: "合わせ込みの様子を見ています",
    Read: "遊びを読んでいます",
    Glob: "遊びを探しています",
    Grep: "遊びを調べています",
    Edit: "遊びを書いています",
    Write: "遊びを書いています",
    Agent: "子どもの目線で確かめています",
    Task: "子どもの目線で確かめています",
    Skill: "手順を確認しています",
  };
  return map[tool] ?? null;
}

export class ClaudeAssistant implements Assistant {
  readonly kind = "claude" as const;
  private sessionId: string | undefined;

  constructor(
    private readonly cwd: string,
    private readonly apiKey: string,
    private readonly opts: { model?: string; maxBudgetUsd?: number } = {},
  ) {}

  reset(): void {
    this.sessionId = undefined;
  }

  async send(prompt: string, emit: (e: AssistantEvent) => void, signal: AbortSignal): Promise<void> {
    const t0 = Date.now();
    const abortController = new AbortController();
    signal.addEventListener("abort", () => abortController.abort());
    let text = "";
    let lastStep = "";
    try {
      const q = query({
        prompt,
        options: {
          cwd: this.cwd,
          // プロジェクトの設定だけを読む（CLAUDE.md・Skills・サブエージェント・フック・.mcp.json）
          settingSources: ["project"],
          // 職員の画面では許可の確認を出せないので、許可されていない操作は断る
          permissionMode: "dontAsk",
          allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Skill", "Agent", "Task", "mcp__wall__*"],
          // 職員モードではシェルとWebは使わない（検証は壁サーバーの道具で行う）
          disallowedTools: ["Bash", "WebFetch", "WebSearch"],
          systemPrompt: { type: "preset", preset: "claude_code", append: STAFF_MODE },
          model: this.opts.model ?? "claude-opus-5-5",
          maxBudgetUsd: this.opts.maxBudgetUsd ?? 3,
          includePartialMessages: true,
          abortController,
          ...(this.sessionId ? { resume: this.sessionId } : {}),
          // キーはこのプロセスにだけ渡す（シェルに置くと Remote Control が動かなくなるため）
          env: { ...(process.env as Record<string, string>), ANTHROPIC_API_KEY: this.apiKey },
        },
      });
      for await (const m of q) {
        if (m.type === "system" && m.subtype === "init") {
          // 何が読み込まれたかを記録する（壁サーバー・Skills・サブエージェントがそろっているか）
          console.error(
            JSON.stringify({
              msg: "assistant.init",
              model: m.model,
              mcp: m.mcp_servers,
              skills: (m as { skills?: unknown }).skills,
              agents: (m as { agents?: unknown }).agents,
              permissionMode: m.permissionMode,
              apiKeySource: m.apiKeySource,
            }),
          );
        }
        if (m.type === "stream_event") {
          // サブエージェントの文字は出さない（親の返事だけ）
          if (m.parent_tool_use_id) continue;
          const ev = m.event;
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            text += ev.delta.text;
            emit({ type: "text", delta: ev.delta.text });
          }
        } else if (m.type === "assistant") {
          for (const block of m.message.content) {
            if (block.type === "tool_use") {
              const s = stepText(block.name);
              if (s && s !== lastStep) {
                lastStep = s;
                emit({ type: "step", text: s });
              }
            }
          }
          // 道具を使う前の文（「確かめますね」など）は、返事の本文から外す
          if (m.message.content.some((b) => b.type === "tool_use") && !m.parent_tool_use_id) text = "";
        } else if (m.type === "result") {
          this.sessionId = m.session_id;
          const final = m.subtype === "success" ? m.result : text;
          emit({ type: "done", text: final || text, costUsd: m.total_cost_usd, seconds: (Date.now() - t0) / 1000 });
          return;
        }
      }
      emit({ type: "done", text, seconds: (Date.now() - t0) / 1000 });
    } catch (e) {
      if (signal.aborted) emit({ type: "error", message: "止めました" });
      else emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }
}

/**
 * 仮の相手。APIキーがない間に、画面の流れを作るために使う。
 * 「大きく」「ゆっくり」「戻して」などは、本当に壁の値を変える（壁サーバーと同じハブの窓口を使う）。
 */
export class MockAssistant implements Assistant {
  readonly kind = "mock" as const;
  private readonly hub = `http://127.0.0.1:${HUB_PORT}`;

  reset(): void {}

  private async wall(body: unknown): Promise<any> {
    const r = await fetch(`${this.hub}/api/wall`, { method: "POST", body: JSON.stringify(body) });
    return r.json();
  }

  async send(prompt: string, emit: (e: AssistantEvent) => void, signal: AbortSignal): Promise<void> {
    const t0 = Date.now();
    const wait = (ms: number) =>
      new Promise<void>((res, rej) => {
        const t = setTimeout(res, ms);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          rej(new Error("止めました"));
        });
      });
    const say = async (s: string) => {
      for (const ch of s) {
        emit({ type: "text", delta: ch });
        await wait(25);
      }
    };
    try {
      const st = await this.wall({ action: "stats" });
      const game: string | null = st.ok ? st.data.game : null;
      const games = await this.wall({ action: "games" });
      const def = games.ok ? (games.data as { id: string; params: Record<string, { value: unknown }> }[]).find((g) => g.id === game) : null;
      const scale = async (key: string, k: number, done: string) => {
        if (!game || !def?.params[key]) return say("この遊びでは、その調整はまだできません。（仮の相手です）");
        emit({ type: "step", text: "調整しています" });
        await wait(600);
        const cur = Number(def.params[key].value);
        await this.wall({ action: "setParams", id: game, values: { [key]: +(cur * k).toFixed(2) } });
        await say(done);
      };
      if (/大きく/.test(prompt)) await scale("size", 1.4, "的を大きくしました。どうですか？");
      else if (/小さく/.test(prompt)) await scale("size", 0.75, "的を小さくしました。どうですか？");
      else if (/ゆっくり|遅く/.test(prompt)) await scale("speed", 0.65, "ゆっくりにしました。どうですか？");
      else if (/速く|はやく/.test(prompt)) await scale("speed", 1.4, "速くしました。どうですか？");
      else if (/戻して|もどして/.test(prompt)) {
        emit({ type: "step", text: "前の遊びに戻しています" });
        const r = await this.wall({ action: "back" });
        await say(r.ok ? "前の遊びに戻しました。" : "戻せる遊びがありませんでした。");
      } else {
        for (const s of ["手順を確認しています", "遊びを書いています", "遊びを確かめています", "壁に出しています"]) {
          emit({ type: "step", text: s });
          await wait(900);
        }
        await say("（仮の相手です）本物の Claude につなぐと、ここで新しい遊びが壁に出ます。");
      }
      emit({ type: "done", text: "", seconds: (Date.now() - t0) / 1000 });
    } catch (e) {
      emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }
}
