import { describe, expect, it } from "vitest";
import type { Hypothesis, Post } from "../../shared/schemas.js";
import { myths } from "./myths.js";
import { prescribeExperiments } from "./experiments.js";
import {
  buildCheckups,
  buildStarter,
  starterExperiments,
  starterPerSide,
  starterTarget,
} from "./starter.js";
import { starterSummary } from "./summary.js";

const asOf = "2026-10-12";

function post(
  id: string,
  title: string,
  publishedAt: string,
  metrics: Partial<Record<string, number>>,
): Post {
  return {
    id,
    title,
    publishedAt,
    format: null,
    url: null,
    metrics: { impressions: null, views: null, coverCtr: null, follows: null, ...metrics },
  };
}

const posts: Post[] = [
  post("p1", "早餐这样吃", "2026-09-01T09:00", {
    impressions: 1000,
    views: 100,
    coverCtr: 0.1,
    follows: 1,
  }),
  post("p2", "通勤穿搭", "2026-09-05T09:00", {
    impressions: 900,
    views: 110,
    coverCtr: 0.12,
    follows: 2,
  }),
  post("p3", "我用 AI 做计划", "2026-09-09T09:00", {
    impressions: 1100,
    views: 400,
    coverCtr: 0.3,
    follows: 3,
  }),
  post("p4", "露营踩坑", "2026-09-13T09:00", {
    impressions: 950,
    views: 90,
    coverCtr: 0.11,
    follows: 1,
  }),
  // Two days old: still settling.
  post("p5", "周末做饭", "2026-10-10T09:00", { impressions: 50, views: 5, coverCtr: 0.25 }),
];

describe("buildCheckups", () => {
  const checkups = buildCheckups("xiaohongshu", posts, "views", asOf);

  it("compares each post with the median of the account's other settled posts", () => {
    expect(checkups[0]?.postId).toBe("p3");
    // Others settled: 100, 110, 90 -> 100.
    expect(checkups[0]?.typical).toBe(100);
    expect(checkups[0]?.standouts.map((item) => item.metric)).toEqual(["coverCtr"]);
    expect(checkups[0]?.standouts[0]).toMatchObject({ value: 0.3, typical: 0.11 });
  });

  it("ignores small counts and keeps settling posts out of the baseline", () => {
    // follows 3 vs 1 is not a standout: both are under 10.
    expect(
      checkups.flatMap((item) => item.standouts).some((item) => item.metric === "follows"),
    ).toBe(false);
    const settling = checkups.find((item) => item.postId === "p5");
    expect(settling?.settling).toBe(true);
    // Its low counts are still growing, so only its rate can stand out.
    expect(settling?.standouts.map((item) => item.metric)).toEqual(["coverCtr"]);
    // p1's settled peers are 110, 400 and 90; counting p5's 5 views would give 100.
    expect(checkups.find((item) => item.postId === "p1")?.typical).toBe(110);
  });
});

describe("starter experiments", () => {
  const ai: Hypothesis = {
    id: "ai-1",
    origin: "ai",
    claim: "标题带“踩坑”更火",
    spec: { kind: "keywords", keywords: ["踩坑"], direction: "higher" },
    metric: null,
    controllable: true,
  };

  it("puts the account's own AI hypotheses first, then cheap common claims", () => {
    const plans = starterExperiments({
      platform: "xiaohongshu",
      posts,
      metric: "views",
      asOf,
      hypotheses: [...myths, ai],
      existing: [],
    });
    expect(plans.map((plan) => plan.hypothesisId)).toEqual([
      "ai-1",
      "myth-question",
      "myth-number",
    ]);
    expect(plans.every((plan) => plan.basis === "starter")).toBe(true);
    expect(plans[0]?.hypothesis).toEqual(ai);
    expect(plans[0]?.schedule).toHaveLength(starterPerSide * 2);
    expect(plans[0]?.instructions.join("")).toContain("AI 根据你的标题提出");
    expect(plans[1]?.instructions.join("")).toContain("不是从你的数据里看出的苗头");
    // Four settled posts are enough to say what the experiment can detect.
    expect(plans[1]?.instructions.join("")).toMatch(/每边 6 篇大约能看出 [\d.]+ 倍以上的差别/);
  });

  it("only fills the room left after real signals, without repeating them", () => {
    const existing = prescribeExperiments([], "xiaohongshu");
    const signal = starterExperiments({
      platform: "xiaohongshu",
      posts,
      metric: "views",
      asOf,
      hypotheses: myths,
      existing: [...existing, { ...stubPlan("myth-question") }, { ...stubPlan("myth-number") }],
    });
    expect(signal.map((plan) => plan.hypothesisId)).toEqual(["myth-big-text"]);
  });

  it("says nothing about detectable size with fewer than four settled posts", () => {
    const [plan] = starterExperiments({
      platform: "xiaohongshu",
      posts: posts.slice(2),
      metric: "views",
      asOf,
      hypotheses: myths,
      existing: [],
    });
    expect(plan?.instructions.join("")).not.toContain("能看出");
  });
});

function stubPlan(hypothesisId: string) {
  return {
    hypothesisId,
    claim: hypothesisId,
    schedule: [],
    variantA: "",
    variantB: "",
    instructions: [],
    reviewAfterDays: 7,
  };
}

describe("buildStarter and its summary", () => {
  it("stops once the account has enough settled posts", () => {
    expect(buildStarter("xiaohongshu", posts, "views", asOf, starterTarget)).toBeNull();
    expect(buildStarter("xiaohongshu", posts, "views", asOf, 4)?.target).toBe(starterTarget);
  });

  it("explains what cannot be said yet, describes the top post and names one next step", () => {
    const starter = buildStarter("xiaohongshu", posts, "views", asOf, 4);
    if (!starter) throw new Error("expected a starter report");
    const plans = starterExperiments({
      platform: "xiaohongshu",
      posts,
      metric: "views",
      asOf,
      hypotheses: myths,
      existing: [],
    });
    const text = starterSummary(starter, plans, posts.length, "xiaohongshu", "views");
    expect(text).toContain("现在有 5 篇笔记，发布满 7 天的有 4 篇");
    expect(text).toContain("“我用 AI 做计划”（400，是一般水平的 4 倍）");
    expect(text).toContain("封面点击率更高：30%，一般是 11%");
    expect(text).toContain("这只是描述，不代表规律");
    expect(text).toContain("先做“问句标题更火”");
  });
});
