import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AiError } from "@/lib/ai/errors";
import { CursorProvider } from "@/lib/ai/providers/cursor";

const prompt = vi.hoisted(() => vi.fn());
const list = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", () => {
  class CursorAgentError extends Error {
    override name = "CursorAgentError";
  }
  class AuthenticationError extends CursorAgentError {}
  class RateLimitError extends CursorAgentError {}
  class ConfigurationError extends CursorAgentError {}
  return {
    Agent: { prompt },
    Cursor: { models: { list } },
    CursorAgentError,
    AuthenticationError,
    RateLimitError,
    ConfigurationError,
  };
});

const provider = () => new CursorProvider("crsr_test", "composer-2.5", 30_000);

beforeEach(() => {
  prompt.mockReset();
  list.mockReset();
});

describe("CursorProvider", () => {
  it("asks a cloud agent with no repository and returns its text", async () => {
    prompt.mockResolvedValue({ status: "finished", result: "A short letter." });
    await expect(provider().complete({ system: "Write plainly.", messages: [{ role: "user", content: "Hello" }] })).resolves.toBe("A short letter.");
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("Hello"), {
      apiKey: "crsr_test",
      model: { id: "composer-2.5" },
      cloud: { repos: [] },
    });
    expect(prompt.mock.calls[0][0]).toContain("Reply with only the answer");
  });

  it("asks for JSON on the first try", async () => {
    prompt.mockResolvedValue({ status: "finished", result: '{"name":"Ada"}' });
    await expect(
      provider().complete({
        system: "Extract.",
        messages: [{ role: "user", content: "Ada" }],
        schema: z.object({ name: z.string() }),
        schemaName: "person",
      }),
    ).resolves.toEqual({ name: "Ada" });
    expect(prompt.mock.calls[0][0]).toContain("Reply with only JSON");
  });

  it("turns a rejected key into an auth error without repeating the key", async () => {
    const { CursorAgentError } = await import("@cursor/sdk");
    prompt.mockRejectedValue(new CursorAgentError("401 invalid api key crsr_test"));
    await expect(provider().complete({ system: "Hi", messages: [{ role: "user", content: "Hi" }] })).rejects.toMatchObject({
      kind: "auth",
    });
    await expect(provider().complete({ system: "Hi", messages: [{ role: "user", content: "Hi" }] })).rejects.toThrow(AiError);
    await expect(provider().complete({ system: "Hi", messages: [{ role: "user", content: "Hi" }] })).rejects.not.toThrow(/crsr_test/);
  });

  it("lists the models the key can use", async () => {
    list.mockResolvedValue([{ id: "composer-2.5" }, { id: "auto" }]);
    await expect(provider().listModels()).resolves.toEqual(["composer-2.5", "auto"]);
    expect(list).toHaveBeenCalledWith({ apiKey: "crsr_test" });
  });
});
