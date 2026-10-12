import { describe, expect, it } from "vitest";
import type { ExperimentPlan, Hypothesis } from "../../shared/schemas.js";
import { generateAccount } from "../synth/synth.js";
import { evaluateExperiment, minPerArm } from "./experimentResult.js";
import { balancedSchedule } from "./experiments.js";
import { myths } from "./myths.js";

const byId = (id: string) => myths.find((myth) => myth.id === id) as Hypothesis;

function plan(hypothesis: Hypothesis, length = 12): ExperimentPlan {
  return {
    hypothesisId: hypothesis.id,
    claim: hypothesis.claim,
    schedule: balancedSchedule(length),
    variantA: "A",
    variantB: "B",
    instructions: [],
    reviewAfterDays: 7,
  };
}

const account = generateAccount({ platform: "xiaohongshu", seed: 11, posts: 90 });
const startIndex = 50;
const startedOn = account.posts[startIndex]?.publishedAt?.slice(0, 10) ?? "2026-06-01";

function run(
  hypothesis: Hypothesis,
  overrides: Partial<Parameters<typeof evaluateExperiment>[0]> = {},
) {
  return evaluateExperiment({
    platform: "xiaohongshu",
    posts: account.posts,
    labels: account.labels,
    asOf: account.asOf,
    datasetId: "d1",
    hypothesis,
    plan: plan(hypothesis),
    metric: "views",
    startedOn,
    iterations: 2000,
    ...overrides,
  });
}

describe("evaluateExperiment", () => {
  it("supports a real effect from posts published after the start", () => {
    const result = run(byId("myth-question"));
    expect(result.rows.length).toBe(account.posts.length - startIndex);
    expect(result.outcome).toBe("supported");
    expect(result.effect).toBeGreaterThan(1);
    expect(result.message).toContain("支持");
  });

  it("does not support a claim with no effect", () => {
    const result = run(byId("myth-exclaim"));
    expect(result.outcome).not.toBe("supported");
  });

  it("waits when nothing was published after the start", () => {
    const result = run(byId("myth-question"), { startedOn: "2030-01-01" });
    expect(result.outcome).toBe("waiting");
    expect(result.rows).toHaveLength(0);
  });

  it("waits until each side has enough settled posts", () => {
    const late = account.posts[account.posts.length - 3]?.publishedAt?.slice(0, 10) ?? startedOn;
    const result = run(byId("myth-question"), { startedOn: late });
    expect(result.outcome).toBe("waiting");
    expect(result.message).toContain(`至少 ${minPerArm} 篇`);
  });

  it("leaves unsettled posts out and says how many", () => {
    const lastDate =
      account.posts[account.posts.length - 1]?.publishedAt?.slice(0, 10) ?? startedOn;
    const result = run(byId("myth-question"), { asOf: lastDate });
    expect(result.nImmature).toBeGreaterThan(0);
    expect(result.rows.filter((row) => !row.mature)).toHaveLength(result.nImmature);
  });

  it("compares the plan with what was actually posted", () => {
    const result = run(byId("myth-question"));
    expect(result.rows[0]?.planned).toBe("A");
    expect(result.known).toBeGreaterThan(0);
    expect(result.followed).toBeLessThanOrEqual(result.known);
  });

  it("assumes the planned side when a label is missing, and marks it", () => {
    const result = run(byId("myth-face"), { labels: {} });
    const planned = result.rows.filter((row) => row.planned !== null);
    expect(planned.every((row) => row.assumed && row.actual === row.planned)).toBe(true);
  });
});
