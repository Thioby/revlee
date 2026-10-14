import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

/** USD per 1M tokens (input, output). Opus 5.5 pricing; override via REVLEE_PRICE_IN/OUT. */
const PRICE: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

export interface Usage { calls: number; tokens_in: number; tokens_out: number; usd: number }

export class ModelClient {
  readonly client: Anthropic | null;
  readonly usage: Usage = { calls: 0, tokens_in: 0, tokens_out: 0, usd: 0 };
  constructor(readonly model: string) {
    this.client = model === "mock" ? null : new Anthropic();
  }
  get isMock() { return this.model === "mock"; }

  account(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) {
    const [pin, pout] = PRICE[this.model] ?? [Number(process.env.REVLEE_PRICE_IN ?? 4), Number(process.env.REVLEE_PRICE_OUT ?? 20)];
    const inTok = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    this.usage.calls++;
    this.usage.tokens_in += inTok;
    this.usage.tokens_out += u.output_tokens;
    this.usage.usd += (u.input_tokens * pin + (u.cache_read_input_tokens ?? 0) * pin * 0.1 + (u.cache_creation_input_tokens ?? 0) * pin * 1.25 + u.output_tokens * pout) / 1e6;
  }

  /** Structured JSON output validated against a zod schema (planner, judge). */
  async parse<T extends z.ZodType>(args: { system: string; content: Anthropic.ContentBlockParam[]; schema: T; effort?: "low" | "medium" | "high" }): Promise<z.infer<T>> {
    if (!this.client) throw new Error("parse() called on mock model");
    const res = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      system: [{ type: "text", text: args.system, cache_control: { type: "ephemeral" } }],
      output_config: { format: zodOutputFormat(args.schema), effort: args.effort ?? "high" },
      messages: [{ role: "user", content: args.content }],
    });
    this.account(res.usage);
    if (res.stop_reason === "refusal") throw new Error(`model refused: ${res.stop_details?.explanation ?? "unknown"}`);
    if (!res.parsed_output) throw new Error("structured output could not be parsed");
    return res.parsed_output;
  }
}

export function imageBlock(pngBase64: string): Anthropic.ImageBlockParam {
  return { type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } };
}
