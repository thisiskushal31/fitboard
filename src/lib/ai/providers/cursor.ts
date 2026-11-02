import "server-only";

import { Agent, AuthenticationError, ConfigurationError, Cursor, CursorAgentError, RateLimitError } from "@cursor/sdk";
import { toJSONSchema } from "zod";

import { AiError } from "../errors";
import { BaseProvider, type ChatAnswer, type ChatCall } from "../provider";

/** The model used when Settings hasn't named one. Composer 2 is redirected to this by Cursor. */
export const CURSOR_DEFAULT_MODEL = "composer-2.5";

/**
 * A Cursor user API key. Cursor has no chat-completions API, so each task is
 * one cloud agent with an empty repository and the answer taken from its text.
 * The key is created at cursor.com/dashboard under API Keys.
 */
export class CursorProvider extends BaseProvider {
  readonly kind = "CURSOR" as const;

  constructor(
    private readonly apiKey: string | null,
    model: string | null,
    timeoutMs: number,
  ) {
    super(model || CURSOR_DEFAULT_MODEL, timeoutMs);
  }

  /** Cursor's agent doesn't take a sampling temperature. */
  protected acceptsTemperature(): boolean {
    return false;
  }

  protected async chat(call: ChatCall): Promise<ChatAnswer> {
    const key = this.apiKey?.trim();
    if (!key) throw AiError.config("Add your Cursor API key in Settings → AI provider.");
    const prompt = renderPrompt(call);
    let settled = false;
    const run = Agent.prompt(prompt, {
      apiKey: key,
      model: { id: call.model },
      cloud: { repos: [] },
    }).then(
      (result) => result,
      (error: unknown) => {
        if (settled) return undefined;
        throw cursorFailure(error);
      },
    );
    const aborted = new Promise<never>((_, reject) => {
      const abort = () => reject(Object.assign(new Error("The call was cancelled."), { name: "AbortError" }));
      if (call.signal.aborted) abort();
      else call.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const result = await Promise.race([run, aborted]);
      settled = true;
      if (!result || result.status === "error") throw AiError.of("provider");
      if (result.status === "cancelled") throw AiError.of("cancelled");
      return { text: result.result ?? "", cutOff: false };
    } catch (error) {
      settled = true;
      throw error;
    }
  }

  protected async fetchModels(signal: AbortSignal): Promise<string[]> {
    const key = this.apiKey?.trim();
    if (!key) return [CURSOR_DEFAULT_MODEL];
    if (signal.aborted) throw Object.assign(new Error("The call was cancelled."), { name: "AbortError" });
    try {
      const models = await Cursor.models.list({ apiKey: key });
      const ids = models.map((model) => model.id).filter(Boolean);
      return ids.length > 0 ? ids : [CURSOR_DEFAULT_MODEL];
    } catch (error) {
      throw cursorFailure(error);
    }
  }
}

/** One prompt: the task, the conversation, and a request for the answer only. */
function renderPrompt(call: ChatCall): string {
  const shape = call.json
    ? `Reply with only JSON matching this schema, and no markdown fence:\n${JSON.stringify(toJSONSchema(call.json.schema))}`
    : "Reply with only the answer. No preamble, no tools, and no files.";
  const turns = call.messages.map((message) => `${message.role === "assistant" ? "Assistant" : "User"}:\n${message.content}`).join("\n\n");
  return `${call.system}\n\n${shape}\n\n${turns}`;
}

/** A Cursor startup failure, without passing the SDK's own text through to the screen. */
function cursorFailure(error: unknown): never {
  if (error instanceof AuthenticationError) throw AiError.of("auth");
  if (error instanceof RateLimitError) throw AiError.of("rate-limited");
  if (error instanceof ConfigurationError) throw AiError.config("Cursor rejected the request. Check the API key and the model name.");
  if (error instanceof CursorAgentError || (error instanceof Error && error.name === "CursorAgentError")) {
    const message = error.message;
    if (/401|403|unauthor|invalid api key/i.test(message)) throw AiError.of("auth");
    if (/429|rate limit/i.test(message)) throw AiError.of("rate-limited");
    throw AiError.of("provider");
  }
  throw error;
}
