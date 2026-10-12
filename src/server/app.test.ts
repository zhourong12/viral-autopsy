import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDatabase } from "./db/database.js";
import { AutopsyService } from "./service.js";

function build(appToken: string | null = null) {
  const service = new AutopsyService({
    db: openDatabase(":memory:"),
    plan: "free",
    llm: null,
    today: () => "2026-10-12",
    iterations: 300,
  });
  return createApp({ service, appToken, plan: "free", models: null });
}

const csv = [
  "笔记标题,发布时间,观看,点赞,收藏",
  ...Array.from({ length: 36 }, (_, index) => {
    const day = String((index % 28) + 1).padStart(2, "0");
    const month = index < 28 ? "06" : "07";
    const question = index % 3 === 0;
    return `${question ? "为什么早餐要这样吃？" : "今天的早餐记录"} ${index},2026-${month}-${day} 20:00,${question ? 4000 + index * 10 : 1500 + index * 10},${100 + index},${50 + index}`;
  }),
].join("\n");

describe("API", () => {
  it("reports health and platforms", async () => {
    const app = build();
    const health = await request(app).get("/api/health").expect(200);
    expect(health.body.ai.configured).toBe(false);
    const list = await request(app).get("/api/platforms").expect(200);
    expect(list.body.platforms.map((platform: { id: string }) => platform.id)).toEqual([
      "xiaohongshu",
      "douyin",
      "bilibili",
      "wechat",
      "youtube",
    ]);
  });

  it("imports a file, requires confirmation, then analyses without AI", async () => {
    const app = build();
    const imported = await request(app)
      .post("/api/datasets/file")
      .send({
        platform: "xiaohongshu",
        accountName: "早餐号",
        fileName: "notes.csv",
        content: Buffer.from(csv).toString("base64"),
        encoding: "base64",
      })
      .expect(201);
    const dataset = imported.body.dataset;
    expect(dataset.posts).toHaveLength(36);
    expect(dataset.confirmed).toBe(false);

    const early = await request(app)
      .post("/api/analyses")
      .send({ datasetId: dataset.id, useAi: false })
      .expect(409);
    expect(early.body.error.code).toBe("not_confirmed");

    await request(app)
      .put(`/api/datasets/${dataset.id}/posts`)
      .send({ posts: dataset.posts })
      .expect(200);
    const analysed = await request(app)
      .post("/api/analyses")
      .send({ datasetId: dataset.id, useAi: false })
      .expect(201);
    const report = analysed.body.report;
    expect(report.mode).toBe("rules_only");
    const question = report.findings.find(
      (finding: { hypothesis: { id: string } }) => finding.hypothesis.id === "myth-question",
    );
    expect(question.verdict).toBe("established");
    await request(app).get(`/api/analyses/${report.id}`).expect(200);
    const history = await request(app).get("/api/analyses").expect(200);
    expect(history.body.analyses).toHaveLength(1);
  });

  it("explains bad input in plain language", async () => {
    const app = build();
    const bad = await request(app)
      .post("/api/datasets/paste")
      .send({ platform: "douyin", accountName: "x", text: "日期,备注\n2026-07-01,无" })
      .expect(400);
    expect(bad.body.error.code).toBe("no_header");
    const invalid = await request(app)
      .post("/api/datasets/paste")
      .send({ platform: "tiktok" })
      .expect(400);
    expect(invalid.body.error.code).toBe("invalid_request");
    await request(app).get("/api/datasets/nope").expect(404);
    await request(app).get("/api/unknown").expect(404);
  });

  it("deletes a dataset on request", async () => {
    const app = build();
    const sample = await request(app)
      .post("/api/datasets/sample")
      .send({ platform: "youtube" })
      .expect(201);
    expect(sample.body.dataset.isSample).toBe(true);
    await request(app).delete(`/api/datasets/${sample.body.dataset.id}`).expect(200);
    await request(app).get(`/api/datasets/${sample.body.dataset.id}`).expect(404);
  });

  it("protects the API with an app token when configured", async () => {
    const app = build("secret-token-123");
    await request(app).get("/api/health").expect(200);
    await request(app).get("/api/platforms").expect(401);
    await request(app)
      .get("/api/platforms")
      .set("Authorization", "Bearer secret-token-123")
      .expect(200);
  });
});
