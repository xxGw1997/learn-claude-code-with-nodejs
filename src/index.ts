import * as readline from "node:readline";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { executeTool, TOOLS } from "./tools";

/*================  CONSTANT CONFIG  ===================*/

export const WORKDIR = process.cwd();
const client = new OpenAI({
  baseURL: Bun.env.BASE_URL!,
  apiKey: Bun.env.ANTHROPIC_API_KEY!,
});
const MODEL = Bun.env.MODEL_ID!;

const SYSTEM_PROMPT = `You are a coding agent at ${WORKDIR}.
  Keep working step by step, and use compact if the conversation gets too long.`;

const SUMMARY_PROMPT = `Summarize this coding-agent conversation so work can continue.
Preserve:
1. The current goal
2. Important findings and decisions
3. Files read or changed
4. Remaining work
5. User constraints and preferences
Be compact but concrete.
`;

const KEEP_RECENT_TOOL_RESULTS = 3;
const CONTEXT_LIMIT = 50_000;
const CONVERSATION_LENGTH = 80_000;
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOOL_RESULTS_DIR = path.join(WORKDIR, ".task_outputs", "tool-results");

const COMPACTED_TOOL_RESULT =
  "[Earlier tool result compacted. Re-run the tool if you need full detail.]";

interface CompactState {
  hasCompacted: boolean;
  lastSummary: string;
  recentFiles: string[];
}

function getMessageStringContent(message: ChatCompletionMessageParam) {
  const content = "content" in message ? message.content : undefined;

  return typeof content === "string" ? content : "";
}

function compactToolResult(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): void {
  const toolMessages = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "tool");

  if (toolMessages.length < KEEP_RECENT_TOOL_RESULTS) {
    return;
  }

  for (const { message, index } of toolMessages.slice(
    0,
    -KEEP_RECENT_TOOL_RESULTS,
  )) {
    const content = getMessageStringContent(message);
    if (content.length <= 120) continue;
    if (message.role === "tool") {
      messages[index] = {
        ...message,
        role: "tool",
        content: COMPACTED_TOOL_RESULT,
      };
    }
  }
}

async function writeTranscript(
  messages: ChatCompletionMessageParam[],
): Promise<string> {
  await fs.mkdir(TRANSCRIPT_DIR, { recursive: true });

  const transcriptPath = path.join(
    TRANSCRIPT_DIR,
    `transcript_${Math.floor(Date.now() / 1000)}.jsonl`,
  );
  const lines = messages.map((message) => JSON.stringify(message)).join("\n");

  await fs.writeFile(transcriptPath, `${lines}\n`);

  return transcriptPath;
}

async function summarizeHistory(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): Promise<string> {
  const conversation = JSON.stringify(messages).slice(0, CONVERSATION_LENGTH);
  const summary_prompt = `${SUMMARY_PROMPT}

  ${conversation}
  `;

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "user",
        content: summary_prompt,
      },
    ],
    max_tokens: 2_000,
  });

  return response.choices[0]?.message.content?.trim() ?? "";
}

async function compactHistory(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  state: CompactState,
  compactFocus?: string,
): Promise<void> {
  const transcriptPath = await writeTranscript(messages);
  console.log(`[transcript saved: ${transcriptPath}]`);

  let summary = await summarizeHistory(messages);

  if (compactFocus) {
    summary += `\n\nFocus to preserve next: ${compactFocus}`;
  }

  state.hasCompacted = true;
  state.lastSummary = summary;

  messages = messages.splice(0, messages.length, {
    role: "user",
    content: `This conversation was compacted so the agent can continue working.
    
    ${summary}
    `,
  });
}

async function compactContext(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  state: CompactState,
): Promise<void> {
  compactToolResult(messages);

  if (JSON.stringify(messages).length > CONTEXT_LIMIT) {
    await compactHistory(messages, state);
  }
}

async function agentLoop(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  state: CompactState,
): Promise<void> {
  while (true) {
    await compactContext(messages, state);

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

    let manualCompact = false;
    let compactFocus: string | undefined;

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== "function") continue;

      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments);

      const toolCallResult = await executeTool(
        functionName,
        functionArgs,
        toolCall.id,
      );

      if (functionName === "compact") {
        manualCompact = true;
        const focus = functionArgs.focus;
        compactFocus = typeof focus === "string" ? focus : undefined;
      }

      messages.push({
        role: "tool",
        content: toolCallResult,
        tool_call_id: toolCall.id,
      });
    }

    if (manualCompact) {
      await compactHistory(messages, state, compactFocus);
    }
  }
}

async function main() {
  const history: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const compactState: CompactState = {
    hasCompacted: false,
    lastSummary: "",
    recentFiles: [],
  };

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

    await agentLoop(history, compactState);

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
