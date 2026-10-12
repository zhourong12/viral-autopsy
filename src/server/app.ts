import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { platformIds, platforms } from "../shared/platforms.js";
import {
  AnalyzeRequestSchema,
  ConfirmRowsRequestSchema,
  ImportFileRequestSchema,
  ImportPasteRequestSchema,
  PlatformIdSchema,
  ScreenshotRequestSchema,
  UpdateLabelsRequestSchema,
} from "../shared/schemas.js";
import { AiError } from "./ai/llm.js";
import { ImportError } from "./import/table.js";
import { AutopsyService, ServiceError } from "./service.js";

export interface AppOptions {
  service: AutopsyService;
  appToken: string | null;
  models: { vision: string; label: string; reason: string } | null;
  plan: string;
  clientMiddleware?: express.RequestHandler[];
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const errorStatus: Record<string, number> = {
  not_found: 404,
  not_confirmed: 409,
  no_metric: 400,
  plan_limit: 402,
  ai_not_configured: 503,
  invalid_posts: 400,
  ai_auth: 502,
  ai_rate_limited: 429,
  ai_timeout: 504,
  ai_network: 502,
  ai_refused: 422,
  ai_truncated: 422,
  ai_invalid_output: 502,
  ai_upstream: 502,
};

export function createApp(options: AppOptions): express.Express {
  const { service } = options;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "45mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      ai: { configured: service.aiConfigured, models: options.models },
      plan: options.plan,
      aiAnalysesLeft: service.aiAnalysesLeft(),
    });
  });

  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (!options.appToken) return next();
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (token && safeEquals(token, options.appToken)) return next();
    res.status(401).json({ error: { code: "unauthorized", message: "需要访问令牌。" } });
  });

  app.get("/api/platforms", (_req, res) => {
    res.json({ platforms: platformIds.map((id) => platforms[id]) });
  });

  app.get("/api/datasets", (_req, res) => {
    res.json({ datasets: service.datasets.list() });
  });

  app.get("/api/datasets/:id", (req, res) => {
    res.json({ dataset: service.requireDataset(req.params.id) });
  });

  app.delete("/api/datasets/:id", (req, res) => {
    const deleted = service.datasets.delete(req.params.id);
    res.status(deleted ? 200 : 404).json({ deleted });
  });

  app.post("/api/datasets/file", async (req, res) => {
    const body = ImportFileRequestSchema.parse(req.body);
    res.status(201).json({ dataset: await service.importFile(body) });
  });

  app.post("/api/datasets/paste", (req, res) => {
    const body = ImportPasteRequestSchema.parse(req.body);
    res.status(201).json({ dataset: service.importPaste(body) });
  });

  app.post("/api/datasets/screenshots", async (req, res) => {
    const body = ScreenshotRequestSchema.parse(req.body);
    res.status(201).json({ dataset: await service.importScreenshots(body) });
  });

  app.post("/api/datasets/sample", (req, res) => {
    const platform = PlatformIdSchema.parse(req.body?.platform);
    res.status(201).json({ dataset: service.createSample(platform) });
  });

  app.put("/api/datasets/:id/posts", (req, res) => {
    const body = ConfirmRowsRequestSchema.parse(req.body);
    res.json({ dataset: service.confirmPosts(req.params.id, body.posts) });
  });

  app.post("/api/datasets/:id/label", async (req, res) => {
    res.json({ dataset: await service.labelDataset(req.params.id) });
  });

  app.put("/api/datasets/:id/labels", (req, res) => {
    const body = UpdateLabelsRequestSchema.parse(req.body);
    res.json({ dataset: service.updateLabels(req.params.id, body.labels) });
  });

  app.post("/api/analyses", async (req, res) => {
    const body = AnalyzeRequestSchema.parse(req.body);
    res.status(201).json({ report: await service.analyze(body) });
  });

  app.get("/api/analyses", (_req, res) => {
    res.json({ analyses: service.analyses.list() });
  });

  app.get("/api/analyses/:id", (req, res) => {
    const report = service.analyses.get(req.params.id);
    if (!report) {
      res.status(404).json({ error: { code: "not_found", message: "找不到这份报告。" } });
      return;
    }
    res.json({ report });
  });

  app.get("/api/usage", (_req, res) => {
    res.json({ month: service.usage.monthTotals(new Date().toISOString().slice(0, 7)) });
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "接口不存在。" } });
  });

  for (const handler of options.clientMiddleware ?? []) app.use(handler);

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      res
        .status(400)
        .json({
          error: {
            code: "invalid_request",
            message: "请求内容不完整或格式不对。",
            issues: error.issues.slice(0, 5),
          },
        });
      return;
    }
    if (error instanceof ImportError) {
      res.status(400).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof ServiceError || error instanceof AiError) {
      res
        .status(errorStatus[error.code] ?? 500)
        .json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (
      error &&
      typeof error === "object" &&
      "type" in error &&
      error.type === "entity.too.large"
    ) {
      res
        .status(413)
        .json({
          error: { code: "too_large", message: "上传内容太大，请减少截图数量或压缩图片。" },
        });
      return;
    }
    console.error("未处理的错误：", error instanceof Error ? error.message : error);
    res.status(500).json({ error: { code: "internal", message: "服务出错了，请稍后重试。" } });
  });

  return app;
}
