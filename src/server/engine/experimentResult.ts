import { getPlatform, metricDef, type PlatformId } from "../../shared/platforms.js";
import type {
  ExperimentOutcome,
  ExperimentPlan,
  ExperimentResult,
  ExperimentRow,
  Hypothesis,
  Post,
  PostLabels,
} from "../../shared/schemas.js";
import {
  Prepared,
  daysBetween,
  effectFromDiff,
  formatEffect,
  formatP,
  thresholds,
} from "./analyze.js";
import {
  bootstrapMedianDiffCi,
  createRng,
  hashSeed,
  neededPerGroup,
  permutationMedianTest,
  robustSd,
} from "./stats.js";

/** Posts per side before an experiment can be judged. */
export const minPerArm = 4;
/** A planned single test needs no multiple-comparison correction; this is its own threshold. */
export const experimentAlpha = 0.1;

/** Which side of the experiment a post is on, from its own title and labels. */
function sideOf(prepared: Prepared, hypothesis: Hypothesis): Array<"A" | "B" | null> {
  const { spec } = hypothesis;
  if (spec.kind === "numeric") {
    if (spec.feature !== "titleLength") return prepared.posts.map(() => null);
    return prepared.numericValues("titleLength").map((length) => {
      if (length === null) return null;
      if (length <= 15) return "A";
      if (length >= 25) return "B";
      return null;
    });
  }
  const membership = prepared.membership(hypothesis) ?? prepared.posts.map(() => null);
  return membership.map((value) => (value === null ? null : value ? "A" : "B"));
}

export interface ExperimentInput {
  platform: PlatformId;
  posts: Post[];
  labels: Record<string, PostLabels>;
  asOf: string;
  datasetId: string;
  hypothesis: Hypothesis;
  plan: ExperimentPlan;
  metric: string;
  startedOn: string;
  iterations?: number;
}

/**
 * Judge a planned experiment on newly imported data. Posts from before the start date only
 * serve as the "nearby posts" baseline; the comparison uses posts published since.
 */
export function evaluateExperiment(input: ExperimentInput): ExperimentResult {
  const platform = getPlatform(input.platform);
  const prepared = new Prepared(input.platform, input.posts, input.labels);
  const series = prepared.series(input.metric);
  const kind = metricDef(input.platform, input.metric)?.kind ?? "count";
  const effectKind = kind === "rate" ? "points" : "ratio";
  const sides = sideOf(prepared, input.hypothesis);

  const rows: ExperimentRow[] = [];
  let slot = 0;
  prepared.posts.forEach((post, index) => {
    if (!post.publishedAt || post.publishedAt.slice(0, 10) < input.startedOn) return;
    const planned = input.plan.schedule[slot] ?? null;
    slot += 1;
    const actualKnown = sides[index] ?? null;
    const actual = actualKnown ?? planned;
    const mature = daysBetween(post.publishedAt, input.asOf) >= platform.maturityDays;
    const rel = series?.rel[index] ?? null;
    rows.push({
      postId: post.id,
      title: post.title,
      publishedAt: post.publishedAt,
      planned,
      actual,
      assumed: actualKnown === null && planned !== null,
      mature,
      relative: rel === null ? null : effectFromDiff(rel, kind).effect,
    });
  });

  const known = rows.filter((row) => !row.assumed && row.actual !== null && row.planned !== null);
  const followed = known.filter((row) => row.actual === row.planned).length;
  const usable = rows.filter((row) => row.mature && row.actual !== null);
  const relOf = (side: "A" | "B") =>
    usable
      .filter((row) => row.actual === side)
      .map((row) => {
        const index = prepared.posts.findIndex((post) => post.id === row.postId);
        return series?.rel[index] ?? null;
      })
      .filter((value): value is number => value !== null);
  const a = relOf("A");
  const b = relOf("B");
  const nImmature = rows.filter((row) => !row.mature).length;

  const base = {
    evaluatedAt: new Date().toISOString(),
    datasetId: input.datasetId,
    nA: a.length,
    nB: b.length,
    nImmature,
    effectKind,
    followed,
    known: known.length,
    rows,
  } as const;

  if (rows.length === 0) {
    return {
      ...base,
      outcome: "waiting",
      message: `${input.startedOn} 之后还没有新发布的内容。按顺序发完后再导入数据。`,
      effect: null,
      ciLow: null,
      ciHigh: null,
      pValue: null,
    };
  }
  if (a.length < minPerArm || b.length < minPerArm) {
    const pending =
      nImmature > 0 ? `另有 ${nImmature} 篇发布不满 ${platform.maturityDays} 天，还不计入。` : "";
    return {
      ...base,
      outcome: "waiting",
      message: `目前 A 组 ${a.length} 篇、B 组 ${b.length} 篇，每组至少 ${minPerArm} 篇才能判断。${pending}按计划继续发。`,
      effect: null,
      ciLow: null,
      ciHigh: null,
      pValue: null,
    };
  }

  const rng = createRng(hashSeed(`experiment:${input.hypothesis.id}:${input.startedOn}`));
  const test = permutationMedianTest(a, b, rng, input.iterations ?? 4000);
  const [low, high] = bootstrapMedianDiffCi(a, b, rng);
  const claimed = input.hypothesis.spec.direction === "higher" ? 1 : -1;
  const sign = Math.sign(test.diff);
  const band = kind === "rate" ? thresholds.noEffectPoints : thresholds.noEffectLog2;
  const effect = effectFromDiff(test.diff, kind).effect;
  const effectText = formatEffect(effect, effectKind);
  const head = `A 组 ${a.length} 篇比 B 组 ${b.length} 篇${effectText}（已扣除同期水平），p=${formatP(test.pValue)}。`;

  let outcome: ExperimentOutcome;
  let message: string;
  if (test.pValue < experimentAlpha && sign === claimed) {
    outcome = "supported";
    message = `${head}这次实验支持“${input.hypothesis.claim}”。`;
  } else if (test.pValue < experimentAlpha) {
    outcome = "not_supported";
    message = `${head}结果和“${input.hypothesis.claim}”正好相反。`;
  } else if (low > -band && high < band) {
    outcome = "not_supported";
    message = `${head}两组差别在 ±25% 以内，这条说法在你的账号上影响不大。`;
  } else {
    outcome = "inconclusive";
    const target = kind === "rate" ? thresholds.targetPoints : thresholds.targetLog2;
    const perGroup = neededPerGroup(robustSd([...a, ...b]), Math.max(Math.abs(test.diff), target));
    const more = Number.isFinite(perGroup)
      ? `大约每组要 ${Math.min(200, perGroup)} 篇才能判断，`
      : "";
    message = `${head}还看不出结论，${more}可以按同样的顺序再做一轮。`;
  }

  return {
    ...base,
    outcome,
    message,
    effect,
    ciLow: effectFromDiff(low, kind).effect,
    ciHigh: effectFromDiff(high, kind).effect,
    pValue: test.pValue,
  };
}
