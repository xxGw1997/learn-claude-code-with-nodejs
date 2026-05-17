import z from "zod";
import { executeTool, genTool, TOOLS } from ".";
import { client, MODEL, SUBAGENT_SYSTEM } from "..";
import type OpenAI from "openai";

const SUBAGENT_MAX_CHAT = 30;

export const RunSubAgentArgsSchema = z.object({
  prompt: z.string().describe("Sub Agent prompt"),
  description: z.string().describe("Short description of the task"),
});

export const runSubAgentTool = genTool(
  "runSubAgent",
  "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
  RunSubAgentArgsSchema,
);

export async function runSubAgent(prompt: string): Promise<string> {
  const subMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: SUBAGENT_SYSTEM,
    },
    {
      role: "user",
      content: prompt,
    },
  ];

  let finalContent = "";

  for (let i = 0; i < SUBAGENT_MAX_CHAT; i++) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: subMessages,
      tools: TOOLS,
    });

    const choice = response.choices[0];

    if (!choice?.message) return "no reply";

    const assistantMessage = choice.message;

    subMessages.push({
      role: "assistant",
      content: assistantMessage.content,
      tool_calls: assistantMessage.tool_calls,
    });

    if (
      choice.finish_reason !== "tool_calls" ||
      !assistantMessage.tool_calls ||
      assistantMessage.tool_calls.length === 0
    ) {
      finalContent = assistantMessage.content ?? "";
      break;
    }

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== "function") continue;

      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments);

      const toolCallResult = await executeTool(
        functionName,
        functionArgs,
        toolCall.id,
      );

      subMessages.push({
        role: "tool",
        content: toolCallResult,
        tool_call_id: toolCall.id,
      });
    }
  }

  return finalContent || "no summary";
}
