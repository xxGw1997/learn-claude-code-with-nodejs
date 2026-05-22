import * as readline from "node:readline/promises";
import OpenAI from "openai";

import { executeTool, TOOLS } from "./tools";

/*================  CONSTANT CONFIG  ===================*/

export const WORKDIR = process.cwd();
const client = new OpenAI({
  baseURL: Bun.env.BASE_URL!,
  apiKey: Bun.env.ANTHROPIC_API_KEY!,
});
const MODEL = Bun.env.MODEL_ID!;

const SYSTEM_PROMPT = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

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
  });

  try {
    while (true) {
      const query = await rl.question("> ");
      const queryTrim = query.trim().toLowerCase();

      if (["exit", "q"].includes(queryTrim)) {
        console.log("bye~");
        break;
      }

      history.push({
        role: "user",
        content: query,
      });

      await agentLoop(history);

      console.log();
      console.log(history[history.length - 1]?.content);
      console.log();
    }
  } finally {
    rl.close();
  }
}

main();
