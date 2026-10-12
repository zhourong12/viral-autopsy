import { getPlatform, metricDef, type PlatformId } from "../../shared/platforms.js";
import type {
  ExperimentPlan,
  Hypothesis,
  Post,
  PostCheckup,
  Standout,
  StarterReport,
} from "../../shared/schemas.js";
import { daysBetween, thresholds } from "./analyze.js";
import { canExperiment, planExperiment } from "./experiments.js";
import { detectableDiff, median, robustSd } from "./stats.js";

/**
 * New accounts. With a handful of posts every claim is "insufficient", which leaves a new
 * creator with nothing to do. Below `starterTarget` settled posts the report adds a per-post
 * checkup (descriptive only, never a verdict) and starter experiments, so the account gathers
 * the evidence it lacks instead of waiting for it.
 */

/** Settled posts at which most claims become testable (groups of 5+ on both sides). */
export const starterTarget = 30;

/** Posts per side in a starter experiment: the check needs 4 settled per side; 6 leaves room. */
export const starterPerSide = 6;

/** Myths to try first: each changes only the title, the cover or the posting time. */
const starterOrder = [
  "myth-question",
  "myth-number",
  "myth-big-text",
  "myth-evening",
  "myth-list",
  "myth-first-person",
];

/** Counts this small are noise; a post with 2 follows is not "twice" one with 1. */
const minCountForStandout = 10;
const minSecondsForStandout = 3;

function isSettled(post: Post, asOf: string, maturityDays: number): boolean {
  return post.publishedAt === null || daysBetween(post.publishedAt, asOf) >= maturityDays;
}

/** How far apart two values are, in units of the smallest difference worth acting on. */
function distance(value: number, typical: number, kind: Standout["kind"]): number {
  if (kind === "rate") return Math.abs(value - typical) / (thresholds.targetPoints / 100);
  return Math.abs(Math.log2(value + 1) - Math.log2(typical + 1)) / thresholds.targetLog2;
}

export function buildCheckups(
  platform: PlatformId,
  posts: Post[],
  metric: string,
  asOf: string,
): PostCheckup[] {
  const def = getPlatform(platform);
  const settled = posts.map((post) => isSettled(post, asOf, def.maturityDays));
  const typicalFor = (key: string, index: number): number | null => {
    const others = posts
      .filter((_, other) => other !== index && settled[other])
      .map((post) => post.metrics[key])
      .filter((value): value is number => value !== null && value !== undefined);
    return others.length >= 2 ? median(others) : null;
  };

  const checkups = posts.map((post, index): PostCheckup => {
    const settling = !settled[index];
    const standouts: Array<Standout & { score: number }> = [];
    for (const m of def.metrics) {
      if (m.key === metric) continue;
      // An unsettled post's counts are still growing; its rates and durations already hold.
      if (settling && m.kind === "count") continue;
      const value = post.metrics[m.key];
      const typical = typicalFor(m.key, index);
      if (value === null || value === undefined || typical === null) continue;
      const largest = Math.max(value, typical);
      if (m.kind === "count" && largest < minCountForStandout) continue;
      if (m.kind === "duration" && largest < minSecondsForStandout) continue;
      const score = distance(value, typical, m.kind);
      if (score >= 1) {
        standouts.push({ metric: m.key, label: m.label, kind: m.kind, value, typical, score });
      }
    }
    standouts.sort((a, b) => b.score - a.score);
    return {
      postId: post.id,
      title: post.title,
      publishedAt: post.publishedAt,
      settling,
      value: post.metrics[metric] ?? null,
      typical: typicalFor(metric, index),
      standouts: standouts.slice(0, 3).map(({ score: _score, ...rest }) => rest),
    };
  });
  return checkups.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
}

/** Null once the account has enough settled posts for the engine's own verdicts. */
export function buildStarter(
  platform: PlatformId,
  posts: Post[],
  metric: string,
  asOf: string,
  postsSettled: number,
): StarterReport | null {
  if (postsSettled >= starterTarget) return null;
  return {
    postsSettled,
    target: starterTarget,
    checkups: buildCheckups(platform, posts, metric, asOf),
  };
}

/** What `starterPerSide` posts a side can detect, given how much this account's posts vary. */
function detectableText(
  platform: PlatformId,
  posts: Post[],
  metric: string,
  asOf: string,
): string | null {
  const def = metricDef(platform, metric);
  const { maturityDays } = getPlatform(platform);
  if (!def) return null;
  const values = posts
    .filter((post) => isSettled(post, asOf, maturityDays))
    .map((post) => post.metrics[metric])
    .filter((value): value is number => value !== null && value !== undefined && value >= 0)
    .map((value) => (def.kind === "rate" ? value * 100 : Math.log2(value + 1)));
  if (values.length < 4) return null;
  const delta = detectableDiff(robustSd(values), starterPerSide);
  if (!Number.isFinite(delta)) return null;
  const size =
    def.kind === "rate"
      ? `${Math.round(delta * 10) / 10} 个百分点`
      : `${Math.round(2 ** delta * 10) / 10} 倍`;
  return `按你现在${def.label}的波动，每边 ${starterPerSide} 篇大约能看出 ${size}以上的差别；差别更小的，要再做一轮。`;
}

/**
 * Experiments for a new account, filling the list up to three after any real signals. The
 * account's own AI hypotheses come first, then the cheapest common claims to test.
 */
export function starterExperiments(input: {
  platform: PlatformId;
  posts: Post[];
  metric: string;
  asOf: string;
  hypotheses: Hypothesis[];
  existing: ExperimentPlan[];
}): ExperimentPlan[] {
  const room = 3 - input.existing.length;
  if (room <= 0) return [];
  const taken = new Set(input.existing.map((plan) => plan.hypothesisId));
  const rank = (hypothesis: Hypothesis) => {
    if (hypothesis.origin === "ai") return -1;
    const index = starterOrder.indexOf(hypothesis.id);
    return index >= 0 ? index : starterOrder.length;
  };
  const chosen = input.hypotheses
    .map((hypothesis, order) => ({ hypothesis, order }))
    .filter(({ hypothesis }) => canExperiment(hypothesis) && !taken.has(hypothesis.id))
    .sort((a, b) => rank(a.hypothesis) - rank(b.hypothesis) || a.order - b.order)
    .slice(0, room)
    .map(({ hypothesis }) => hypothesis);

  const detectable = detectableText(input.platform, input.posts, input.metric, input.asOf);
  return chosen.map((hypothesis) =>
    planExperiment(hypothesis, starterPerSide * 2, input.platform, "starter", [
      hypothesis.origin === "ai"
        ? "这是 AI 根据你的标题提出的猜想，篇数太少还检验不了，用实验来验证。"
        : "这不是从你的数据里看出的苗头（篇数还太少），而是常见说法里只改一处、最值得先验证的。",
      ...(detectable ? [detectable] : []),
    ]),
  );
}
