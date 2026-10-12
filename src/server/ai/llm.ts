import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { z } from "zod";
import type { UsageSummary } from "../../shared/schemas.js";

export type AiErrorCode =
  | "ai_not_configured"
  | "ai_auth"
  | "ai_rate_limited"
  | "ai_timeout"
  | "ai_network"
  | "ai_refused"
  | "ai_truncated"
  | "ai_invalid_output"
  | "ai_upstream";

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

/** The steps that call a model. Each can run on its own model. */
export type AiStage = "vision" | "label" | "reason";

export interface StructuredRequest<T> {
  stage: AiStage;
  /** Static instructions; cached across requests. Keep volatile data out of it. */
  system: string;
  /** Per-request data: plain text, or text plus images. */
  content: string | BetaContentBlockParam[];
  schema: z.ZodType<T>;
  maxTokens: number;
  label: string;
}

export interface StructuredResult<T> {
  data: T;
  usage: UsageSummary;
}

/** The only thing the pipeline needs from a model. Tests inject a fake. */
export interface StructuredLlm {
  modelFor(stage: AiStage): string;
  generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

/** USD per million tokens (first-party API list prices, cached 2026-10-06). */
const pricing: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export function estimateCostUsd(
  model: string,
  usage: Omit<UsageSummary, "model" | "costUsd">,
): number | null {
  const price = pricing[model];
  if (!price) return null;
  const cacheWritePrice = price.input * 1.25;
  const cost =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * cacheWritePrice) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelConfig {
  default: string;
  vision: string;
  label: string;
  reason: string;
  effort: Effort;
}

export function isAiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.VA_AI_ENABLED === "true");
}

/** Claude Opus 5.5 everywhere unless a stage is overridden on purpose. */
export function modelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const base = env.VA_MODEL?.trim() || "claude-opus-5-5";
  const effortValue = env.VA_EFFORT?.trim();
  const effort: Effort =
    effortValue === "low" ||
    effortValue === "high" ||
    effortValue === "xhigh" ||
    effortValue === "max"
      ? effortValue
      : "medium";
  return {
    default: base,
    vision: env.VA_VISION_MODEL?.trim() || base,
    label: env.VA_LABEL_MODEL?.trim() || base,
    reason: env.VA_REASON_MODEL?.trim() || base,
    effort,
  };
}

function mapError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return new AiError("ai_auth", "Claude API Key 无效或没有权限。");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AiError("ai_rate_limited", "Claude 调用过于频繁，请稍后再试。");
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new AiError("ai_timeout", "Claude 响应超时，请稍后重试。");
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AiError("ai_network", "无法连接 Claude 服务。");
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new AiError("ai_upstream", "Claude 拒绝了这次请求的参数，请检查模型配置。");
  }
  if (error instanceof Anthropic.APIError) {
    return new AiError("ai_upstream", `Claude 服务暂时不可用（${error.status ?? "未知状态"}）。`);
  }
  return new AiError("ai_upstream", "调用 Claude 时出现未知错误。");
}

/**
 * Claude via the official SDK: structured outputs validated by Zod, cached system prompt,
 * server-side refusal fallback, and explicit handling of refusal / max_tokens stops.
 */
export class AnthropicLlm implements StructuredLlm {
  private readonly config: ModelConfig;
  private readonly client: Anthropic;

  constructor(options: { config?: ModelConfig; client?: Anthropic; apiKey?: string } = {}) {
    this.config = options.config ?? modelConfig();
    this.client =
      options.client ??
      new Anthropic({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        timeout: 120_000,
        maxRetries: 2,
      });
  }

  modelFor(stage: AiStage): string {
    return this.config[stage];
  }

  async generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const model = this.modelFor(request.stage);
    let message;
    try {
      message = await this.client.beta.messages.parse({
        model,
        max_tokens: request.maxTokens,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: this.config.effort, format: betaZodOutputFormat(request.schema) },
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: request.content }],
      });
    } catch (error) {
      throw mapError(error);
    }
    if (message.stop_reason === "refusal") {
      throw new AiError("ai_refused", "Claude 拒绝处理这段内容。");
    }
    if (message.stop_reason === "max_tokens") {
      throw new AiError("ai_truncated", "输出过长被截断，请减少一次处理的条数后重试。");
    }
    const data = message.parsed_output;
    if (data === null || data === undefined) {
      throw new AiError("ai_invalid_output", "Claude 返回的结构不符合预期。");
    }
    // The fallback chain may serve the request on another model; bill by what actually ran.
    const servedModel = message.model ?? model;
    const usage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    };
    return {
      data: data as T,
      usage: { model: servedModel, ...usage, costUsd: estimateCostUsd(servedModel, usage) },
    };
  }
}
