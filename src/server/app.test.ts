import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDatabase } from "./db/database.js";
import { accountExport, noteExport, toXlsx } from "./import/workbookFixtures.js";
import type { Sheet } from "./import/table.js";
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
        files: [
          {
            fileName: "notes.csv",
            content: Buffer.from(csv).toString("base64"),
            encoding: "base64",
          },
        ],
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

describe("column mapping API", () => {
  const odd = [
    "名字,日子,数A",
    ...Array.from({ length: 6 }, (_, i) => `内容 ${i},2026-06-0${i + 1},${100 + i}`),
  ].join("\n");

  it("previews, imports with a manual mapping, and remembers it for the same layout", async () => {
    const app = build();
    const first = await request(app)
      .post("/api/imports/preview")
      .send({ kind: "paste", platform: "bilibili", text: odd })
      .expect(200);
    expect(first.body.preview.complete).toBe(false);
    expect(first.body.preview.fromSaved).toBe(false);

    const assignment = { headerRow: 0, columns: ["title", "publishedAt", "metric:views"] };
    await request(app)
      .post("/api/datasets/paste")
      .send({ platform: "bilibili", accountName: "x", text: odd })
      .expect(400);
    const imported = await request(app)
      .post("/api/datasets/paste")
      .send({ platform: "bilibili", accountName: "x", text: odd, assignment })
      .expect(201);
    expect(imported.body.dataset.posts).toHaveLength(6);

    const again = await request(app)
      .post("/api/imports/preview")
      .send({ kind: "paste", platform: "bilibili", text: odd })
      .expect(200);
    expect(again.body.preview.fromSaved).toBe(true);
    expect(again.body.preview.complete).toBe(true);
    expect(again.body.preview.posts[0].metrics.views).toBe(100);
    // Without an explicit assignment, the remembered one is used.
    await request(app)
      .post("/api/datasets/paste")
      .send({ platform: "bilibili", accountName: "x", text: odd })
      .expect(201);
    // Another platform does not inherit it.
    const other = await request(app)
      .post("/api/imports/preview")
      .send({ kind: "paste", platform: "douyin", text: odd })
      .expect(200);
    expect(other.body.preview.fromSaved).toBe(false);
  });

  it("rejects an invalid mapping in plain language", async () => {
    const app = build();
    const bad = await request(app)
      .post("/api/datasets/paste")
      .send({
        platform: "bilibili",
        accountName: "x",
        text: odd,
        assignment: { headerRow: 0, columns: ["title", "title", "metric:views"] },
      })
      .expect(400);
    expect(bad.body.error.code).toBe("invalid_mapping");
  });
});

describe("single-post export API", () => {
  async function upload(fileName: string, sheets: Sheet[]) {
    return { fileName, content: (await toXlsx(sheets)).toString("base64"), encoding: "base64" };
  }

  it("previews and imports several note exports as one post each", async () => {
    const app = build();
    const files = [
      await upload(
        "第一篇.xlsx",
        noteExport({ startDay: "2026-09-23", impressions: 1500, views: 300, ctrPercent: 20 }),
      ),
      await upload(
        "第二篇.xlsx",
        noteExport({ startDay: "2026-10-02", impressions: 80, views: 9, ctrPercent: 11 }),
      ),
    ];
    const preview = await request(app)
      .post("/api/imports/preview")
      .send({ kind: "file", platform: "xiaohongshu", files })
      .expect(200);
    expect(preview.body.preview.kind).toBe("posts");
    expect(preview.body.preview.posts).toHaveLength(2);

    const imported = await request(app)
      .post("/api/datasets/file")
      .send({ platform: "xiaohongshu", accountName: "x", files })
      .expect(201);
    expect(imported.body.dataset.posts.map((post: { title: string }) => post.title)).toEqual([
      "第一篇",
      "第二篇",
    ]);
    expect(imported.body.dataset.confirmed).toBe(false);
  });

  it("explains the account export instead of mapping its columns", async () => {
    const app = build();
    const response = await request(app)
      .post("/api/imports/preview")
      .send({
        kind: "file",
        platform: "xiaohongshu",
        files: [await upload("近30日观看数据.xlsx", accountExport())],
      })
      .expect(400);
    expect(response.body.error.code).toBe("account_level");
  });
});

describe("experiment API", () => {
  it("starts an experiment from a report, checks it against data and records the outcome", async () => {
    const app = build();
    const sample = await request(app)
      .post("/api/datasets/sample")
      .send({ platform: "xiaohongshu" })
      .expect(201);
    const analysed = await request(app)
      .post("/api/analyses")
      .send({ datasetId: sample.body.dataset.id, useAi: false })
      .expect(201);
    const report = analysed.body.report;
    expect(report.experiments.length).toBeGreaterThan(0);
    const hypothesisId = report.experiments[0].hypothesisId;

    const started = await request(app)
      .post("/api/experiments")
      .send({ reportId: report.id, hypothesisId })
      .expect(201);
    expect(started.body.experiment.status).toBe("running");
    expect(started.body.experiment.startedOn).toBe("2026-10-12");
    const again = await request(app)
      .post("/api/experiments")
      .send({ reportId: report.id, hypothesisId })
      .expect(201);
    expect(again.body.experiment.id).toBe(started.body.experiment.id);

    // The sample's posts are all older than today, so nothing belongs to the experiment yet.
    const checked = await request(app)
      .post(`/api/experiments/${started.body.experiment.id}/check`)
      .send({ datasetId: sample.body.dataset.id })
      .expect(200);
    expect(checked.body.experiment.result.outcome).toBe("waiting");

    const list = await request(app).get("/api/experiments").expect(200);
    expect(list.body.experiments).toHaveLength(1);
    const abandoned = await request(app)
      .patch(`/api/experiments/${started.body.experiment.id}`)
      .send({ status: "abandoned" })
      .expect(200);
    expect(abandoned.body.experiment.status).toBe("abandoned");
  });

  it("refuses data from another platform", async () => {
    const app = build();
    const sample = await request(app)
      .post("/api/datasets/sample")
      .send({ platform: "douyin" })
      .expect(201);
    const report = (
      await request(app)
        .post("/api/analyses")
        .send({ datasetId: sample.body.dataset.id, useAi: false })
    ).body.report;
    const started = await request(app)
      .post("/api/experiments")
      .send({
        reportId: report.id,
        hypothesisId: report.experiments[0].hypothesisId,
        startedOn: "2026-06-01",
      })
      .expect(201);
    const other = await request(app)
      .post("/api/datasets/sample")
      .send({ platform: "bilibili" })
      .expect(201);
    const refused = await request(app)
      .post(`/api/experiments/${started.body.experiment.id}/check`)
      .send({ datasetId: other.body.dataset.id })
      .expect(400);
    expect(refused.body.error.code).toBe("experiment_mismatch");
    const checked = await request(app)
      .post(`/api/experiments/${started.body.experiment.id}/check`)
      .send({ datasetId: sample.body.dataset.id })
      .expect(200);
    expect(checked.body.experiment.result.rows.length).toBeGreaterThan(0);
  });
});

describe("new accounts", () => {
  it("adds a checkup and starter experiments, which can be started without a finding", async () => {
    const app = build();
    const notes = [
      ["早餐这样吃，一周瘦三斤？", "2026-09-02", 1500, 300, 20],
      ["通勤穿搭 5 套", "2026-09-06", 800, 60, 8],
      ["租房改造花了 300 块", "2026-09-10", 900, 80, 9],
      ["第一次露营", "2026-09-14", 700, 70, 10],
    ] as const;
    const files = await Promise.all(
      notes.map(async ([title, startDay, impressions, views, ctrPercent]) => ({
        fileName: `${title}.xlsx`,
        content: (await toXlsx(noteExport({ startDay, impressions, views, ctrPercent }))).toString(
          "base64",
        ),
        encoding: "base64",
      })),
    );
    const imported = await request(app)
      .post("/api/datasets/file")
      .send({ platform: "xiaohongshu", accountName: "新号", files })
      .expect(201);
    const dataset = imported.body.dataset;
    await request(app)
      .put(`/api/datasets/${dataset.id}/posts`)
      .send({ posts: dataset.posts })
      .expect(200);
    const analysed = await request(app)
      .post("/api/analyses")
      .send({ datasetId: dataset.id, useAi: false })
      .expect(201);
    const report = analysed.body.report;

    expect(report.starter.postsSettled).toBe(4);
    expect(report.starter.checkups[0].title).toBe("早餐这样吃，一周瘦三斤？");
    expect(report.summary).toContain("现在有 4 篇笔记");
    expect(report.experiments).toHaveLength(3);
    expect(report.experiments.every((plan: { basis: string }) => plan.basis === "starter")).toBe(
      true,
    );

    // On so few posts some starter claims have no finding at all (no title here is a question);
    // the plan carries its own hypothesis, so the experiment still starts.
    const plan = report.experiments.find(
      (item: { hypothesisId: string }) =>
        !report.findings.some(
          (finding: { hypothesis: { id: string } }) => finding.hypothesis.id === item.hypothesisId,
        ),
    );
    expect(plan).toBeDefined();
    const started = await request(app)
      .post("/api/experiments")
      .send({ reportId: report.id, hypothesisId: plan.hypothesisId })
      .expect(201);
    expect(started.body.experiment.hypothesis.id).toBe(plan.hypothesisId);
    expect(started.body.experiment.metric).toBe("views");
  });
});
