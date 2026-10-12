import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { AnthropicLlm, isAiConfigured, modelConfig } from "./ai/llm.js";
import { createApp } from "./app.js";
import { openDatabase } from "./db/database.js";
import { AutopsyService } from "./service.js";

async function clientMiddleware(isProduction: boolean): Promise<express.RequestHandler[]> {
  if (isProduction) {
    const dist = resolve(process.cwd(), "dist");
    if (!existsSync(dist)) return [];
    return [
      express.static(dist, { index: false, maxAge: "1h" }),
      (_req, res) => res.sendFile(resolve(dist, "index.html")),
    ];
  }
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
  return [vite.middlewares];
}

async function main() {
  const isProduction = process.env.NODE_ENV === "production";
  const port = Number(process.env.PORT) || 8793;
  const host = process.env.HOST?.trim() || "127.0.0.1";
  const plan = process.env.VA_PLAN === "pro" ? "pro" : "free";
  const appToken = process.env.VA_APP_TOKEN?.trim() || null;
  if (isProduction && host !== "127.0.0.1" && !appToken) {
    throw new Error("生产环境对外监听时必须设置 VA_APP_TOKEN。");
  }
  const db = openDatabase(
    resolve(process.cwd(), process.env.VA_DB_PATH?.trim() || "var/viral-autopsy.db"),
  );
  const aiConfigured = isAiConfigured();
  const models = modelConfig();
  const service = new AutopsyService({
    db,
    plan,
    llm: aiConfigured ? new AnthropicLlm({ config: models }) : null,
  });
  const app = createApp({
    service,
    appToken,
    plan,
    models: aiConfigured
      ? { vision: models.vision, label: models.label, reason: models.reason }
      : null,
    clientMiddleware: await clientMiddleware(isProduction),
  });
  app.listen(port, host, () => {
    console.log(`爆款解剖室已启动：http://${host}:${port}`);
    console.log(
      aiConfigured
        ? `AI：已启用（${models.default}，effort=${models.effort}）`
        : "AI：未配置 ANTHROPIC_API_KEY，只做表格导入和规则检验",
    );
  });
}

main().catch((error: unknown) => {
  console.error("启动失败：", error instanceof Error ? error.message : error);
  process.exit(1);
});
