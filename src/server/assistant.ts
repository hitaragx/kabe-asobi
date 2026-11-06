// 職員の頼みごとを受けて、Claude Code（Agent SDK）に遊びを作らせる・直させる。
// - ClaudeAssistant：本物。プロジェクトの CLAUDE.md・Skills・サブエージェント・フック・壁サーバーをそのまま使う
// - MockAssistant：APIキーがないとき用の仮の相手。画面の流れを作るために使う
//
// 認証は APIキー（ANTHROPIC_API_KEY）。職員が使う画面なので、claude.ai のログインは使わない（Agent SDK の利用規定）。

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { HUB_PORT } from "../shared/protocol.ts";

/** 作り始める前に職員に見せる、遊びの案 */
export type Plan = {
  id: string;
  /** 遊びの名前（ひらがな多めで） */
  title: string;
  /** どんな遊びか（1〜2文） */
  summary: string;
  /** 遊び方と、頼みごとに合わせたところ（短く2〜4つ） */
  points: string[];
};

/** 画面に送る出来事 */
export type AssistantEvent =
  /** 何をしているか（短い一言。コードは見せない） */
  | { type: "step"; text: string }
  /** 返事の文字（少しずつ届く） */
  | { type: "text"; delta: string }
  | { type: "done"; text: string; costUsd?: number; seconds: number; turns?: number }
  | { type: "error"; message: string }
  /** 作り始める前の案。職員が「これで作って」を押すまで作らない */
  | { type: "plan"; plan: Plan }
  /** 裏側の画面用：Claude が何をしたか（職員の画面には出さない） */
  | { type: "trace"; at: number; kind: TraceKind; label: string; detail?: string; ok?: boolean; sub?: boolean };

export type TraceKind = "model" | "skill" | "mcp" | "subagent" | "edit" | "read" | "hook" | "result";

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
- **新しい遊びを作るとき・遊びを大きく作り変えるときは、書き始める前に必ず propose_plan で案を見せて、そこで返事を終える。** 職員が「この案で作って」と返したら作る。「ここを変えて」と返ったら案を直して、もう一度 propose_plan で見せる
  - 案がいらないもの：大きさ・速さ・数など値の調整、音の調整、戻す、遊びの切り替え、壁への合わせ込み
  - 職員が「確認しなくていい」「おまかせで」と言ったときは、案を省いて作ってよい
- 遊びを作る・変えるときは new-game スキル、遊んでいる最中の調整は tune スキル、壁への合わせ込みは calibrate スキルの手順に従う
- 壁に出す前に必ず verify_game で確かめ、壁に出すのは publish_game だけ
- publish_game には必ず reason を付ける（なぜこの頼みごとから、この遊び・直し方にしたか。職員があとで「きろく」で読む）
- 「大きく」「ゆっくり」など params で済むものは set_params で直す
- 音楽・効果音の大きさ、曲の雰囲気は set_audio で直す
- 終わったら、何を変えたかを一言で伝え、「どうですか？」と聞く
- 分からないことは推測で大きく作り変えず、1問だけ聞く
- 子ども向けでない頼みごと（性的・残酷・武器で傷つける・本気で怖がらせる・差別やからかい・ギャンブル・既存キャラクター）は作らない。既存キャラクターの代わりは、名前・色・特徴も似せない別の生きものにする。責めずに一言で理由を伝え、子ども向けに直した代わりの案を propose_plan で出す
`.trim();

/** 道具の名前 → 職員に見せる一言 */
function stepText(tool: string): string | null {
  const map: Record<string, string> = {
    mcp__staff__propose_plan: "案をまとめています",
    mcp__wall__verify_game: "遊びを確かめています",
    mcp__wall__publish_game: "壁に出しています",
    mcp__wall__set_audio: "音を調整しています",
    mcp__wall__rollback_game: "前の版に戻しています",
    mcp__wall__previous_game: "前の遊びに戻しています",
    mcp__wall__show_game: "遊びを切り替えています",
    mcp__wall__set_params: "調整しています",
    mcp__wall__set_zones: "壁を区画に分けています",
    mcp__wall__reset_params: "元の設定に戻しています",
    mcp__wall__wall_screenshot: "壁を見ています",
    mcp__wall__wall_status: "壁の様子を見ています",
    mcp__wall__list_games: "遊びの一覧を見ています",
    mcp__wall__calibrate_start: "壁に合わせる準備をしています",
    mcp__wall__calibrate_status: "合わせ込みの様子を見ています",
    mcp__wall__calibrate_redo: "合わせ込みをやり直しています",
    mcp__wall__calibrate_cancel: "合わせ込みをやめています",
    mcp__wall__sensor_tuning: "センサーの設定を見ています",
    mcp__wall__sensor_tuning_set: "センサーを調整しています",
    mcp__wall__sensor_relearn: "壁の背景を覚え直しています",
    mcp__wall__sensor_objects: "センサーが見ている物を調べています",
    mcp__wall__list_recordings: "センサーの記録を探しています",
    mcp__wall__analyze_recording: "センサーの記録を分析しています",
    mcp__wall__test_hit: "反応を試しています",
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

function shortName(tool: string): string {
  if (tool.startsWith("mcp__wall__")) return tool.slice(11);
  if (tool.startsWith("mcp__staff__")) return tool.slice(12);
  if (tool === "Agent" || tool === "Task") return "サブエージェント";
  return tool;
}

/** 職員の画面に案を出す道具。スマホのサーバーの中で動く（壁サーバーとは別） */
function staffServer(onPlan: (p: Omit<Plan, "id">) => void) {
  return createSdkMcpServer({
    name: "staff",
    version: "1.0.0",
    tools: [
      tool(
        "propose_plan",
        "新しい遊びを作る前に、職員のスマホに遊びの案を見せる。職員が「この案で作って」と返すまで、遊びを書き始めない。言葉はやさしい日本語で、専門用語は使わない。",
        {
          title: z.string().describe("遊びの名前（ひらがな多めで短く。例：おにを やっつけろ）"),
          summary: z.string().describe("どんな遊びか。1〜2文"),
          points: z.array(z.string()).min(1).max(4).describe("遊び方と、頼みごとに合わせたところ。1つ20字くらいで2〜4つ（例：「勝ち負けは出さず、みんなで数える」「的は大きめ・ゆっくり」）"),
        },
        async (args) => {
          onPlan(args);
          return {
            content: [
              {
                type: "text",
                text: "職員のスマホに案を見せました。まだ遊びを書き始めないでください。返事は「こんな案でどうでしょう。よければ『これで作って』を押してください。変えたいところがあれば教えてください。」くらいの一言にして、ここで終えてください。",
              },
            ],
          };
        },
        { alwaysLoad: true },
      ),
    ],
  });
}

export class ClaudeAssistant implements Assistant {
  readonly kind = "claude" as const;
  private sessionId: string | undefined;
  private planSeq = 0;
  /** 会話のこれまでの費用。SDK の total_cost_usd は、続きの会話では前の分も足した合計になるので、差を1回分にする */
  private sessionCost = 0;

  constructor(
    private readonly cwd: string,
    private readonly apiKey: string,
    private readonly opts: { model?: string; maxBudgetUsd?: number } = {},
  ) {}

  reset(): void {
    this.sessionId = undefined;
    this.sessionCost = 0;
  }

  async send(prompt: string, emit: (e: AssistantEvent) => void, signal: AbortSignal): Promise<void> {
    const t0 = Date.now();
    const abortController = new AbortController();
    signal.addEventListener("abort", () => abortController.abort());
    let text = "";
    let lastStep = "";
    const tools = new Map<string, string>(); // 道具の呼び出しID → 名前
    const trace = (e: Omit<Extract<AssistantEvent, { type: "trace" }>, "type" | "at">) =>
      emit({ type: "trace", at: (Date.now() - t0) / 1000, ...e });
    // 画面に出すパスはリポジトリからの相対にする（Windows の \ 区切りも / にそろえる）
    const root = `${this.cwd.replaceAll("\\", "/")}/`;
    const rel = (p: unknown) => String(p ?? "").replaceAll("\\", "/").replace(root, "");
    try {
      const q = query({
        prompt,
        options: {
          cwd: this.cwd,
          // プロジェクトの設定だけを読む（CLAUDE.md・Skills・サブエージェント・フック・.mcp.json）
          settingSources: ["project"],
          // 職員の画面では許可の確認を出せないので、許可されていない操作は断る
          permissionMode: "dontAsk",
          allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Skill", "Agent", "Task", "mcp__wall__*", "mcp__staff__*"],
          // 壁サーバー（.mcp.json）に加えて、案を見せる道具
          mcpServers: {
            staff: staffServer((p) => emit({ type: "plan", plan: { id: `p${Date.now().toString(36)}${++this.planSeq}`, ...p } })),
          },
          // 職員モードではシェルとWebは使わない（検証は壁サーバーの道具で行う）
          disallowedTools: ["Bash", "WebFetch", "WebSearch"],
          systemPrompt: { type: "preset", preset: "claude_code", append: STAFF_MODE },
          model: this.opts.model ?? "claude-opus-5-5",
          maxBudgetUsd: this.opts.maxBudgetUsd ?? 3,
          includePartialMessages: true,
          includeHookEvents: true,
          abortController,
          ...(this.sessionId ? { resume: this.sessionId } : {}),
          // キーはこのプロセスにだけ渡す（シェルに置くと Remote Control が動かなくなるため）
          env: { ...(process.env as Record<string, string>), ANTHROPIC_API_KEY: this.apiKey },
        },
      });
      for await (const m of q) {
        if (m.type === "system" && m.subtype === "init") {
          trace({
            kind: "model",
            label: m.model,
            detail: `壁サーバー：${m.mcp_servers.map((x) => `${x.name} ${x.status}`).join("、")}`,
          });
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
        } else if (m.type === "system" && m.subtype === "hook_response") {
          const out = `${m.stdout ?? ""}${m.stderr ?? ""}`;
          let detail = out.trim().slice(0, 120);
          try {
            const j = JSON.parse(m.stdout);
            detail = j.hookSpecificOutput?.additionalContext ?? j.reason ?? detail;
          } catch {
            // JSON でない出力はそのまま
          }
          const hookOk = m.outcome === "success" && (m.exit_code ?? 0) === 0;
          // 何も言わずに通した実行前の見張りは出さない（止めたときだけ出す）
          if (!(m.hook_event === "PreToolUse" && hookOk && !detail))
            trace({ kind: "hook", label: `フック：${m.hook_event}${hookOk ? "" : "（止めました）"}`, detail, ok: hookOk });
        } else if (m.type === "user" && Array.isArray(m.message.content)) {
          for (const b of m.message.content) {
            if (typeof b !== "object" || b.type !== "tool_result") continue;
            const name = tools.get(b.tool_use_id) ?? "";
            const body = Array.isArray(b.content) ? b.content.map((c) => (c.type === "text" ? c.text : "")).join("") : String(b.content ?? "");
            let ok = !b.is_error;
            let detail = "";
            if (name === "mcp__wall__verify_game" || name === "mcp__wall__publish_game") {
              try {
                const j = JSON.parse(body);
                ok = j.ok ?? j.published ?? ok;
                const r = j.results?.[0] ?? j.verify?.results?.[0];
                detail = r ? `FPS ${r.fps}${r.problems?.length ? `、${r.problems.join("、").slice(0, 80)}` : ""}` : "";
              } catch {
                // そのまま
              }
            }
            if (name.startsWith("mcp__wall__") || name === "Agent" || name === "Task" || b.is_error)
              trace({ kind: "result", label: `${shortName(name)}：${ok ? "合格" : "不合格"}`, detail, ok, sub: Boolean(m.parent_tool_use_id) });
          }
        } else if (m.type === "assistant") {
          for (const block of m.message.content) {
            if (block.type === "tool_use") {
              tools.set(block.id, block.name);
              const inp = (block.input ?? {}) as Record<string, unknown>;
              const sub = Boolean(m.parent_tool_use_id);
              if (block.name === "Skill") trace({ kind: "skill", label: `Skill：${inp.skill ?? inp.name ?? ""}`, sub });
              else if (block.name === "Agent" || block.name === "Task")
                trace({ kind: "subagent", label: `サブエージェント：${inp.subagent_type ?? ""}`, detail: String(inp.description ?? ""), sub });
              else if (block.name === "mcp__staff__propose_plan") trace({ kind: "mcp", label: "案を見せる：propose_plan", detail: String(inp.title ?? ""), sub });
              else if (block.name.startsWith("mcp__wall__")) {
                const { id, ...rest } = inp;
                const args = Object.keys(rest).length ? JSON.stringify(rest).slice(0, 90) : "";
                trace({ kind: "mcp", label: `壁サーバー：${block.name.slice(11)}`, detail: [id, args].filter(Boolean).join(" "), sub });
              } else if (block.name === "Edit" || block.name === "Write") trace({ kind: "edit", label: `${block.name}：${rel(inp.file_path)}`, sub });
              else if (block.name === "Read") trace({ kind: "read", label: `Read：${rel(inp.file_path)}`, sub });
              else if (block.name === "Glob" || block.name === "Grep") trace({ kind: "read", label: `${block.name}：${String(inp.pattern ?? "")}`, sub });
            }
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
          const total = m.total_cost_usd;
          const costUsd = total >= this.sessionCost ? total - this.sessionCost : total;
          this.sessionCost = total;
          emit({ type: "done", text: final || text, costUsd, seconds: (Date.now() - t0) / 1000, turns: m.num_turns });
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
        emit({ type: "trace", at: (Date.now() - t0) / 1000, kind: "mcp", label: "壁サーバー：set_params（仮の相手）", detail: `${game} ${key}×${k}` });
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
      } else if (/この案で/.test(prompt)) {
        for (const s of ["手順を確認しています", "遊びを書いています", "遊びを確かめています", "壁に出しています"]) {
          emit({ type: "step", text: s });
          await wait(900);
        }
        await say("（仮の相手です）本物の Claude につなぐと、ここで新しい遊びが壁に出ます。");
      } else {
        // 新しい遊びの頼みごと：まず案を見せる
        emit({ type: "step", text: "案をまとめています" });
        await wait(700);
        emit({
          type: "plan",
          plan: {
            id: `mock${Date.now().toString(36)}`,
            title: "（仮）おにを やっつけろ",
            summary: "壁を歩く鬼に、ボールを当てる遊びです。当たると鬼が「まいった」と逃げていきます。",
            points: ["勝ち負けは出さず、みんなで当てた数を数える", "鬼は大きめで、ゆっくり歩く", "節分らしい和風の音楽"],
          },
        });
        await say("（仮の相手です）こんな案でどうでしょう。よければ「これで作って」を押してください。");
      }
      emit({ type: "done", text: "", seconds: (Date.now() - t0) / 1000 });
    } catch (e) {
      emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }
}
