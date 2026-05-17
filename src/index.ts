import * as readline from "node:readline";
import OpenAI from "openai";

import { executeTool, TOOLS } from "./tools";
import { TODO } from "./tools/todo";

/*================  CONSTANT CONFIG  ===================*/

export const WORKDIR = process.cwd();
const client = new OpenAI({
  baseURL: Bun.env.BASE_URL!,
  apiKey: Bun.env.ANTHROPIC_API_KEY!,
});
const MODEL = Bun.env.MODEL_ID!;

const SYSTEM_PROMPT = `You are a coding agent at ${WORKDIR}.
Use the todo tool for multi-step work.
Keep exactly one step in_progress when a task has multiple steps.
Refresh the plan as work advances. Prefer tools over prose.`;

async function agentLoop(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): Promise<void> {
  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL!,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      tools: TOOLS,
    });

    const choice = response.choices[0];

    if (!choice?.message) return;

    const assistantMessage = choice.message;

    messages.push({
      role: "assistant",
      content: assistantMessage.content,
      tool_calls: assistantMessage.tool_calls,
    });

    // 如果返回的内容不是工具调用 或 工具调用是空的 -> 则当作正常回答，本轮问答结束
    if (
      choice.finish_reason !== "tool_calls" ||
      !assistantMessage.tool_calls ||
      assistantMessage.tool_calls.length === 0
    )
      return;

    let usedTodo = false;

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== "function") continue;

      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments);

      const toolCallResult = await executeTool(
        functionName,
        functionArgs,
        toolCall.id,
      );

      messages.push({
        role: "tool",
        content: toolCallResult,
        tool_call_id: toolCall.id,
      });

      if (toolCall.function.name === "todo") {
        usedTodo = true;
      }
    }
    if (usedTodo) TODO.state.roundsSinceUpdate = 0;
    else {
      TODO.noteRoundWithoutUpdate();
      const reminder = TODO.reminder();
      if (reminder) messages.push({ role: "user", content: reminder });
    }
  }
}

async function main() {
  const history: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "🧐: \x1b[0m ",
  });

  rl.prompt();

  rl.on("line", async (query: string) => {
    const queryTrim = query.trim().toLowerCase();

    if (["exit", "q"].includes(queryTrim)) {
      console.log("bye~👋🏻");
      rl.close();
      return;
    }

    history.push({
      role: "user",
      content: query,
    });

    await agentLoop(history);

    console.log();
    console.log(history[history.length - 1]?.content);
    console.log();
    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

main();
