import * as readline from "node:readline";
import OpenAI from "openai";
import { WORKDIR } from "./config";

import { executeTool, TOOLS } from "./tools";
import { SKILL_REGISTRY } from "./tools/skills";

/*================  CONSTANT CONFIG  ===================*/

const client = new OpenAI({
  baseURL: Bun.env.BASE_URL!,
  apiKey: Bun.env.ANTHROPIC_API_KEY!,
});
const MODEL = Bun.env.MODEL_ID!;

const SYSTEM_PROMPT = `You are a coding agent at ${WORKDIR}.
Use load_skill when a task needs specialized instructions before you act.
Skills available:
${SKILL_REGISTRY.listAvailableSkills()}
`;

async function agentLoop(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): Promise<void> {
  while (true) {
    const rawResponse = await client.chat.completions.create({
      model: MODEL!,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      tools: TOOLS,
    });

    const response =
      typeof rawResponse === "string" ? JSON.parse(rawResponse) : rawResponse;

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
