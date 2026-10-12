import { describe, expect, it } from "vitest";
import type { Hypothesis, Post } from "../../shared/schemas.js";
import { buildAllowedNumbers, unverifiedNumbers } from "../guards/numberGuard.js";
import { generateAccount } from "../synth/synth.js";
import { runEngine } from "./analyze.js";
import { balancedSchedule, prescribeExperiments } from "./experiments.js";
import { computeFeatures, timeParts } from "./features.js";
import { myths } from "./myths.js";
import {
  benjaminiHochberg,
  bootstrapMedianDiffCi,
  createRng,
  median,
  neededPerGroup,
  permutationMedianTest,
  spearman,
} from "./stats.js";
import { templateSummary } from "./summary.js";

describe("stats", () => {
  it("computes medians like sorting does", () => {
    const rng = createRng(7);
    for (let trial = 0; trial < 50; trial += 1) {
      const values = Array.from({ length: 1 + Math.floor(rng() * 30) }, () =>
        Math.round(rng() * 100),
      );
      const sorted = values.slice().sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      const expected =
        sorted.length % 2
          ? sorted[mid]
          : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
      expect(median(values)).toBe(expected);
    }
  });

  it("matches the textbook Benjamini–Hochberg example", () => {
    const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.005]);
    expect(q.map((value) => Math.round(value * 1000) / 1000)).toEqual([0.02, 0.04, 0.04, 0.02]);
  });

  it("finds a clear difference and ignores noise", () => {
    const rng = createRng(1);
    const a = Array.from({ length: 30 }, () => rng() + 1);
    const b = Array.from({ length: 30 }, () => rng());
    expect(permutationMedianTest(a, b, createRng(2), 1000).pValue).toBeLessThan(0.01);
    const c = Array.from({ length: 30 }, () => rng());
    expect(permutationMedianTest(c, b, createRng(3), 1000).pValue).toBeGreaterThan(0.05);
  });

  it("is reproducible with the same seed", () => {
    const a = [1, 2, 3, 4, 5, 6];
    const b = [2, 3, 4, 5, 6, 7];
    const first = permutationMedianTest(a, b, createRng(9), 500);
    const second = permutationMedianTest(a, b, createRng(9), 500);
    expect(first).toEqual(second);
    const [low, high] = bootstrapMedianDiffCi(a, b, createRng(4), 500);
    expect(low).toBeLessThanOrEqual(high);
  });

  it("computes Spearman correlation with ties", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1);
    expect(spearman([1, 1, 2, 2], [1, 1, 2, 2])).toBeCloseTo(1);
  });

  it("asks for more posts when the spread is wide", () => {
    expect(neededPerGroup(1, 0.5)).toBeGreaterThan(neededPerGroup(0.5, 0.5));
  });
});

describe("features", () => {
  it("reads hour and weekday from local time strings", () => {
    expect(timeParts("2026-07-04T21:30")).toEqual({ day: 6, hour: 21 });
    expect(timeParts("2026-07-06")).toEqual({ day: 1, hour: null });
  });

  it("derives title features", () => {
    const post: Post = {
      id: "a",
      title: "【干货】我做了 30 天早餐，绝了？",
      publishedAt: null,
      format: null,
      metrics: {},
      url: null,
    };
    const row = computeFeatures([post], {}).get("a");
    expect(row).toMatchObject({
      titleHasNumber: true,
      titleQuestion: true,
      titleFirstPerson: true,
      titleBrackets: true,
      titleHype: true,
      weekend: null,
      isTutorial: null,
    });
  });
});

describe("runEngine on synthetic accounts", () => {
  const account = generateAccount({ platform: "xiaohongshu", seed: 3 });
  const result = runEngine({
    platform: "xiaohongshu",
    posts: account.posts,
    labels: account.labels,
    metric: "views",
    hypotheses: myths,
    asOf: account.asOf,
    iterations: 1000,
  });
  const byId = new Map(result.findings.map((finding) => [finding.hypothesis.id, finding]));

  it("establishes the planted effects", () => {
    expect(byId.get("myth-question")?.verdict).toBe("established");
    expect(byId.get("myth-tutorial-collects")?.verdict).toBe("established");
    expect(byId.get("myth-tutorial-collects")?.metric).toBe("collects");
  });

  it("buries the face-cover trap as a growth-period effect", () => {
    const face = byId.get("myth-face");
    expect(face?.verdict).toBe("buried");
    expect(face?.cause).toBe("time_confound");
    expect(face?.evidence).toContain("发布时期");
  });

  it("never establishes the outlier trap", () => {
    expect(byId.get("myth-number")?.verdict).not.toBe("established");
  });

  it("moves features that never occur to untested", () => {
    expect(result.untested.map((item) => item.claim)).toContain("标题带话题标签更火");
  });

  it("records the checks behind every judged finding", () => {
    const question = byId.get("myth-question");
    expect(question?.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining(["leave_top_out", "raw_metric", "halves"]),
    );
    expect(question?.test.qValue).not.toBeNull();
  });

  it("excludes posts that are too new and says so", () => {
    const fresh = runEngine({
      platform: "xiaohongshu",
      posts: account.posts,
      labels: account.labels,
      metric: "views",
      hypotheses: myths.slice(0, 2),
      asOf: account.posts[account.posts.length - 1]?.publishedAt?.slice(0, 10) ?? account.asOf,
      iterations: 200,
    });
    expect(fresh.postsExcluded).toBeGreaterThan(0);
    expect(fresh.exclusionNotes[0]).toContain("不满 7 天");
  });

  it("turns off time adjustment when dates are missing", () => {
    const undated = account.posts.map((post) => ({ ...post, publishedAt: null }));
    const noDates = runEngine({
      platform: "xiaohongshu",
      posts: undated,
      labels: account.labels,
      metric: "views",
      hypotheses: myths.slice(0, 3),
      asOf: account.asOf,
      iterations: 200,
    });
    expect(noDates.timeAdjusted).toBe(false);
    expect(noDates.warnings.join("")).toContain("缺少发布时间");
  });

  it("marks small groups as insufficient instead of guessing", () => {
    const small = runEngine({
      platform: "xiaohongshu",
      posts: account.posts.slice(0, 12),
      labels: account.labels,
      metric: "views",
      hypotheses: myths,
      asOf: account.asOf,
      iterations: 200,
    });
    const tooSmall = small.findings.filter(
      (finding) =>
        Math.min(finding.test.nWith, finding.test.nWithout) < 5 &&
        finding.test.effectKind !== "correlation",
    );
    expect(tooSmall.length).toBeGreaterThan(0);
    expect(tooSmall.every((finding) => finding.verdict === "insufficient")).toBe(true);
    expect(tooSmall.every((finding) => finding.test.pValue === null)).toBe(true);
    expect(small.warnings.join("")).toContain("少于 30 篇");
  });

  it("tests AI-style keyword hypotheses with the same machinery", () => {
    const keyword: Hypothesis = {
      id: "ai-1",
      origin: "ai",
      claim: "标题带“为什么”更火",
      spec: { kind: "keywords", keywords: ["为什么"], direction: "higher" },
      metric: null,
      controllable: true,
    };
    const keywordResult = runEngine({
      platform: "xiaohongshu",
      posts: account.posts,
      labels: account.labels,
      metric: "views",
      hypotheses: [keyword],
      asOf: account.asOf,
      iterations: 1000,
    });
    expect(keywordResult.findings[0]?.verdict).toBe("established");
  });

  it("prescribes balanced experiments for unproven controllable findings", () => {
    const plans = prescribeExperiments(result.findings, "xiaohongshu");
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.length).toBeLessThanOrEqual(3);
    for (const plan of plans) {
      expect(plan.schedule.filter((slot) => slot === "A").length).toBe(plan.schedule.length / 2);
      expect(plan.instructions[0]).toContain(plan.variantA);
    }
    expect(balancedSchedule(8)).toEqual(["A", "B", "B", "A", "A", "B", "B", "A"]);
  });

  it("writes a summary whose numbers all come from the engine", () => {
    const plans = prescribeExperiments(result.findings, "xiaohongshu");
    const summary = templateSummary(result.findings, plans, result.postsUsed, "xiaohongshu");
    const allowed = buildAllowedNumbers(
      [
        ...result.findings.map((finding) => finding.evidence),
        ...plans.flatMap((plan) => plan.instructions),
      ],
      [
        result.postsUsed,
        result.findings.length,
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        11,
        12,
        13,
        14,
        15,
        16,
        17,
        18,
        19,
        20,
      ],
    );
    expect(unverifiedNumbers(summary, allowed)).toEqual([]);
  });
});

describe("numberGuard", () => {
  it("flags numbers the engine never produced", () => {
    const allowed = buildAllowedNumbers(["问句标题的 23 篇高 143%，q=0.03。"]);
    expect(unverifiedNumbers("问句标题高 143%，23 篇。", allowed)).toEqual([]);
    expect(unverifiedNumbers("问句标题高 150%，阅读能翻三倍。", allowed)).toEqual(["150", "3"]);
    expect(unverifiedNumbers("有十二篇是问句。", allowed)).toEqual(["12"]);
    expect(unverifiedNumbers("1,234 次阅读", buildAllowedNumbers(["1234"]))).toEqual([]);
  });
});
