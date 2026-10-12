import {
  getPlatform,
  metricDef,
  type MetricKind,
  type PlatformId,
} from "../../shared/platforms.js";
import type {
  CauseOfDeath,
  CheckResult,
  DoubtReason,
  Finding,
  Hypothesis,
  Post,
  PostLabels,
  TestOutcome,
  Verdict,
} from "../../shared/schemas.js";
import { categoryValueLabel, computeFeatures, getFeature, type FeatureTable } from "./features.js";
import {
  benjaminiHochberg,
  bootstrapMedianDiffCi,
  createRng,
  hashSeed,
  median,
  neededPerGroup,
  permutationMedianTest,
  permutationSpearmanTest,
  robustSd,
} from "./stats.js";

/** Thresholds. Exploration-stage choices, documented in the README. */
export const thresholds = {
  minGroup: 5,
  minNumericPairs: 10,
  qEstablished: 0.1,
  pRaw: 0.05,
  pWeak: 0.2,
  leaveTopOutKill: 0.2,
  leaveTopOutWeak: 0.1,
  /** Counts: an effect inside ±25% counts as "no real difference". */
  noEffectLog2: Math.log2(1.25),
  /** Rates: inside ±1.5 percentage points. */
  noEffectPoints: 1.5,
  noEffectRho: 0.15,
  /** Smallest effect worth planning an experiment for: 1.5× for counts, 2 points for rates. */
  targetLog2: Math.log2(1.5),
  targetPoints: 2,
  neighborWindow: 5,
} as const;

export interface EngineInput {
  platform: PlatformId;
  posts: Post[];
  labels: Record<string, PostLabels>;
  /** Default metric for hypotheses that do not name one. */
  metric: string;
  hypotheses: Hypothesis[];
  /** YYYY-MM-DD the numbers were read on. */
  asOf: string;
  iterations?: number;
}

export interface EngineResult {
  postsUsed: number;
  postsExcluded: number;
  exclusionNotes: string[];
  /** True when posts could be ordered by date, so growth over time is adjusted for. */
  timeAdjusted: boolean;
  findings: Finding[];
  untested: Array<{ claim: string; reason: string }>;
  warnings: string[];
}

interface Series {
  kind: MetricKind;
  raw: Array<number | null>;
  /** Transformed: log2(v + 1) for counts and durations, percentage points for rates. */
  y: Array<number | null>;
  /** y minus the median of nearby posts (or of all posts when there are no dates). */
  rel: Array<number | null>;
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
  return Math.round((to - from) / 86400000);
}

function transform(value: number | null, kind: MetricKind): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  return kind === "rate" ? value * 100 : Math.log2(value + 1);
}

class Prepared {
  readonly posts: Post[];
  readonly features: FeatureTable;
  readonly timeAdjusted: boolean;
  private readonly seriesCache = new Map<string, Series>();

  constructor(
    readonly platform: PlatformId,
    posts: Post[],
    labels: Record<string, PostLabels>,
  ) {
    this.timeAdjusted = posts.length > 0 && posts.every((post) => post.publishedAt !== null);
    this.posts = this.timeAdjusted
      ? posts.slice().sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""))
      : posts.slice();
    this.features = computeFeatures(this.posts, labels);
  }

  series(metric: string): Series | null {
    const cached = this.seriesCache.get(metric);
    if (cached) return cached;
    const def = metricDef(this.platform, metric);
    if (!def) return null;
    const raw = this.posts.map((post) => post.metrics[metric] ?? null);
    const y = raw.map((value) => transform(value, def.kind));
    const present = y.filter((value): value is number => value !== null);
    if (present.length === 0) return null;
    const overall = median(present);
    const rel = y.map((value, index) => {
      if (value === null) return null;
      if (!this.timeAdjusted) return value - overall;
      const neighbors: number[] = [];
      for (
        let step = 1, before = 0;
        before < thresholds.neighborWindow && index - step >= 0;
        step += 1
      ) {
        const candidate = y[index - step];
        if (candidate !== null && candidate !== undefined) {
          neighbors.push(candidate);
          before += 1;
        }
      }
      for (
        let step = 1, after = 0;
        after < thresholds.neighborWindow && index + step < y.length;
        step += 1
      ) {
        const candidate = y[index + step];
        if (candidate !== null && candidate !== undefined) {
          neighbors.push(candidate);
          after += 1;
        }
      }
      return value - (neighbors.length >= 3 ? median(neighbors) : overall);
    });
    const series = { kind: def.kind, raw, y, rel };
    this.seriesCache.set(metric, series);
    return series;
  }

  /** Group membership per post: true, false, or null when unknown. */
  membership(hypothesis: Hypothesis): Array<boolean | null> | null {
    const { spec } = hypothesis;
    if (spec.kind === "keywords") {
      const words = spec.keywords.map((word) => word.toLowerCase());
      return this.posts.map((post) =>
        words.some((word) => post.title.toLowerCase().includes(word)),
      );
    }
    if (spec.kind === "numeric") return null;
    const feature = getFeature(spec.feature);
    if (!feature) return null;
    return this.posts.map((post) => {
      const value = this.features.get(post.id)?.[spec.feature] ?? null;
      if (value === null) return null;
      if (spec.kind === "category") return String(value) === spec.equals;
      return value === true;
    });
  }

  numericValues(feature: string): Array<number | null> {
    return this.posts.map((post) => {
      const value = this.features.get(post.id)?.[feature];
      return typeof value === "number" ? value : null;
    });
  }

  /** Stratifier for the confounding check: topic labels if there are several, else format. */
  stratum(excludeFeature: string | null): { label: string; values: Array<string | null> } | null {
    const topics = this.posts.map((post) => {
      const value = this.features.get(post.id)?.topic;
      return typeof value === "string" ? value : null;
    });
    if (excludeFeature !== "topic" && new Set(topics.filter(Boolean)).size >= 2) {
      return { label: "选题", values: topics };
    }
    const formats = this.posts.map((post) => post.format);
    if (excludeFeature !== "isVideo" && new Set(formats.filter(Boolean)).size >= 2) {
      return { label: "内容形式", values: formats };
    }
    return null;
  }
}

function signOf(value: number): number {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

export function formatEffect(effect: number, kind: TestOutcome["effectKind"]): string {
  if (kind === "ratio") {
    const percent = Math.round((effect - 1) * 100);
    return `${percent >= 0 ? "高" : "低"} ${Math.abs(percent)}%`;
  }
  if (kind === "points") {
    const points = Math.round(effect * 10) / 10;
    return `${points >= 0 ? "高" : "低"} ${Math.abs(points)} 个百分点`;
  }
  return `相关系数 ${(Math.round(effect * 100) / 100).toFixed(2)}`;
}

export function formatP(value: number | null): string {
  if (value === null) return "—";
  if (value < 0.001) return "<0.001";
  return value < 0.01 ? value.toFixed(3) : value.toFixed(2);
}

function effectFromDiff(
  diff: number,
  kind: MetricKind,
): { effect: number; effectKind: TestOutcome["effectKind"] } {
  return kind === "rate"
    ? { effect: diff, effectKind: "points" }
    : { effect: 2 ** diff, effectKind: "ratio" };
}

interface PendingFinding {
  hypothesis: Hypothesis;
  metric: string;
  insufficient: boolean;
  /** Effect on the transformed scale (log2 difference, points, or rho). */
  diff: number;
  rawDiff: number | null;
  rawP: number | null;
  ltoDiff: number | null;
  ltoP: number | null;
  ltoTitle: string | null;
  halvesAgree: boolean | null;
  halvesDetail: string;
  strataFlipped: boolean | null;
  strataDetail: string;
  test: TestOutcome;
  ciLowRaw: number | null;
  ciHighRaw: number | null;
  sd: number;
  kind: MetricKind;
  numeric: boolean;
}

function sideLabel(hypothesis: Hypothesis): { withLabel: string; withoutLabel: string } {
  const { spec } = hypothesis;
  if (spec.kind === "keywords") {
    return { withLabel: `标题带“${spec.keywords.join("/")}”`, withoutLabel: "其他" };
  }
  if (spec.kind === "category") {
    return { withLabel: categoryValueLabel(spec.feature, spec.equals), withoutLabel: "其他" };
  }
  const feature = getFeature(spec.feature);
  return { withLabel: feature?.label ?? spec.feature, withoutLabel: "其他" };
}

function evaluate(
  prepared: Prepared,
  hypothesis: Hypothesis,
  metric: string,
  iterations: number,
): PendingFinding | { untested: string } {
  const series = prepared.series(metric);
  const def = metricDef(prepared.platform, metric);
  if (!series || !def) return { untested: `没有“${def?.label ?? metric}”这一列数据。` };
  const rng = createRng(hashSeed(`${hypothesis.id}:${metric}`));
  const included = series.rel
    .map((value, index) => ({ value, index }))
    .filter((item): item is { value: number; index: number } => item.value !== null);
  const sd = robustSd(included.map((item) => item.value));

  if (hypothesis.spec.kind === "numeric") {
    const xs = prepared.numericValues(hypothesis.spec.feature);
    const pairs = included.filter(
      (item) => xs[item.index] !== null && xs[item.index] !== undefined,
    );
    if (pairs.length === 0) return { untested: "这一项没有可用数据（比如缺少发布时间）。" };
    const x = pairs.map((item) => xs[item.index] as number);
    if (new Set(x).size < 3) return { untested: "取值太少，无法看趋势。" };
    const base: PendingFinding = {
      hypothesis,
      metric,
      insufficient: pairs.length < thresholds.minNumericPairs,
      diff: 0,
      rawDiff: null,
      rawP: null,
      ltoDiff: null,
      ltoP: null,
      ltoTitle: null,
      halvesAgree: null,
      halvesDetail: "",
      strataFlipped: null,
      strataDetail: "",
      sd,
      kind: series.kind,
      numeric: true,
      ciLowRaw: null,
      ciHighRaw: null,
      test: {
        nWith: pairs.length,
        nWithout: 0,
        medianWith: null,
        medianWithout: null,
        effect: null,
        effectKind: "correlation",
        ciLow: null,
        ciHigh: null,
        pValue: null,
        qValue: null,
      },
    };
    if (base.insufficient) return base;
    const yRel = pairs.map((item) => item.value);
    const main = permutationSpearmanTest(x, yRel, rng, iterations);
    base.diff = main.rho;
    base.test.effect = main.rho;
    base.test.pValue = main.pValue;
    if (prepared.timeAdjusted) {
      const raw = permutationSpearmanTest(
        x,
        pairs.map((item) => series.y[item.index] as number),
        rng,
        Math.floor(iterations / 2),
      );
      base.rawDiff = raw.rho;
      base.rawP = raw.pValue;
    }
    const top = pairs.reduce((best, item) => (item.value > best.value ? item : best));
    const keep = pairs.filter((item) => item !== top);
    const lto = permutationSpearmanTest(
      keep.map((item) => xs[item.index] as number),
      keep.map((item) => item.value),
      rng,
      Math.floor(iterations / 2),
    );
    base.ltoDiff = lto.rho;
    base.ltoP = lto.pValue;
    base.ltoTitle = prepared.posts[top.index]?.title ?? null;
    return base;
  }

  const members = prepared.membership(hypothesis);
  if (!members) return { untested: "引擎不认识这个特征。" };
  const groupWith = included.filter((item) => members[item.index] === true);
  const groupWithout = included.filter((item) => members[item.index] === false);
  if (groupWith.length + groupWithout.length === 0) {
    const feature =
      hypothesis.spec.kind === "keywords" ? null : getFeature(hypothesis.spec.feature);
    return {
      untested:
        feature?.source === "label"
          ? "需要先给内容打标签（AI 标注或手动标注）才能检验。"
          : "这一项没有可用数据（比如缺少发布时间或内容形式）。",
    };
  }
  if (groupWith.length === 0 || groupWithout.length === 0) {
    const { withLabel } = sideLabel(hypothesis);
    return {
      untested:
        groupWith.length === 0
          ? `${included.length} 篇里没有“${withLabel}”的内容，没法比较。`
          : `${included.length} 篇全都是“${withLabel}”，没法比较。`,
    };
  }
  const a = groupWith.map((item) => item.value);
  const b = groupWithout.map((item) => item.value);
  const rawValues = (items: typeof included) =>
    items.map((item) => series.raw[item.index]).filter((value): value is number => value !== null);
  const pending: PendingFinding = {
    hypothesis,
    metric,
    insufficient: Math.min(a.length, b.length) < thresholds.minGroup,
    diff: 0,
    rawDiff: null,
    rawP: null,
    ltoDiff: null,
    ltoP: null,
    ltoTitle: null,
    halvesAgree: null,
    halvesDetail: "",
    strataFlipped: null,
    strataDetail: "",
    sd,
    kind: series.kind,
    numeric: false,
    ciLowRaw: null,
    ciHighRaw: null,
    test: {
      nWith: a.length,
      nWithout: b.length,
      medianWith: a.length ? median(rawValues(groupWith)) : null,
      medianWithout: b.length ? median(rawValues(groupWithout)) : null,
      effect: null,
      effectKind: series.kind === "rate" ? "points" : "ratio",
      ciLow: null,
      ciHigh: null,
      pValue: null,
      qValue: null,
    },
  };
  if (pending.insufficient) return pending;

  const main = permutationMedianTest(a, b, rng, iterations);
  const [ciLow, ciHigh] = bootstrapMedianDiffCi(a, b, rng);
  pending.diff = main.diff;
  pending.ciLowRaw = ciLow;
  pending.ciHighRaw = ciHigh;
  const shown = effectFromDiff(main.diff, series.kind);
  pending.test.effect = shown.effect;
  pending.test.ciLow = effectFromDiff(ciLow, series.kind).effect;
  pending.test.ciHigh = effectFromDiff(ciHigh, series.kind).effect;
  pending.test.pValue = main.pValue;

  if (prepared.timeAdjusted) {
    const yOf = (items: typeof included) => items.map((item) => series.y[item.index] as number);
    const raw = permutationMedianTest(
      yOf(groupWith),
      yOf(groupWithout),
      rng,
      Math.floor(iterations / 2),
    );
    pending.rawDiff = raw.diff;
    pending.rawP = raw.pValue;
  }

  // Leave the single best-performing post out: does the pattern survive without it?
  const top = included.reduce((best, item) => (item.value > best.value ? item : best));
  const aKeep = groupWith.filter((item) => item !== top).map((item) => item.value);
  const bKeep = groupWithout.filter((item) => item !== top).map((item) => item.value);
  if (aKeep.length >= 2 && bKeep.length >= 2) {
    const lto = permutationMedianTest(aKeep, bKeep, rng, Math.floor(iterations / 2));
    pending.ltoDiff = lto.diff;
    pending.ltoP = lto.pValue;
    pending.ltoTitle = prepared.posts[top.index]?.title ?? null;
  }

  // First half versus second half of the timeline.
  if (prepared.timeAdjusted) {
    const cut = Math.floor(prepared.posts.length / 2);
    const half = (from: number, to: number) => {
      const inA = groupWith
        .filter((item) => item.index >= from && item.index < to)
        .map((item) => item.value);
      const inB = groupWithout
        .filter((item) => item.index >= from && item.index < to)
        .map((item) => item.value);
      return inA.length >= 2 && inB.length >= 2 ? median(inA) - median(inB) : null;
    };
    const first = half(0, cut);
    const second = half(cut, prepared.posts.length);
    if (first !== null && second !== null) {
      pending.halvesAgree =
        signOf(first) === signOf(second) || Math.abs(first) < 0.05 || Math.abs(second) < 0.05;
      const fmt = (d: number) =>
        formatEffect(effectFromDiff(d, series.kind).effect, pending.test.effectKind);
      pending.halvesDetail = `前半段${fmt(first)}，后半段${fmt(second)}。`;
    } else {
      pending.halvesDetail = "某一段里两组不够 2 篇，跳过这项检查。";
    }
  }

  // Within strata (topic, else format): does the direction hold inside each group?
  const exclude = hypothesis.spec.kind === "keywords" ? null : hypothesis.spec.feature;
  const strata = prepared.stratum(exclude);
  if (strata) {
    let weighted = 0;
    let totalWeight = 0;
    const strataValues = new Set(strata.values.filter((value): value is string => value !== null));
    for (const value of strataValues) {
      const inA = groupWith
        .filter((item) => strata.values[item.index] === value)
        .map((item) => item.value);
      const inB = groupWithout
        .filter((item) => strata.values[item.index] === value)
        .map((item) => item.value);
      if (inA.length >= 2 && inB.length >= 2) {
        const weight = Math.min(inA.length, inB.length);
        weighted += weight * signOf(median(inA) - median(inB));
        totalWeight += weight;
      }
    }
    if (totalWeight >= 4) {
      pending.strataFlipped = signOf(weighted) !== 0 && signOf(weighted) !== signOf(main.diff);
      pending.strataDetail = pending.strataFlipped
        ? `按${strata.label}分开看，多数组里方向和整体相反。`
        : `按${strata.label}分开看，方向和整体一致。`;
    } else {
      pending.strataDetail = `按${strata.label}分开后每组篇数太少，跳过这项检查。`;
    }
  }
  return pending;
}

function needed(pending: PendingFinding): number | null {
  if (pending.numeric) return null;
  const target = pending.kind === "rate" ? thresholds.targetPoints : thresholds.targetLog2;
  const delta = Math.max(Math.abs(pending.diff), target);
  const value = neededPerGroup(pending.sd, delta);
  if (!Number.isFinite(value)) return null;
  return Math.min(200, Math.max(thresholds.minGroup, value));
}

function decide(pending: PendingFinding): {
  verdict: Verdict;
  cause: CauseOfDeath | null;
  doubt: DoubtReason | null;
} {
  if (pending.insufficient) return { verdict: "insufficient", cause: null, doubt: null };
  const claimed = pending.hypothesis.spec.direction === "higher" ? 1 : -1;
  const sign = signOf(pending.diff);
  const p = pending.test.pValue ?? 1;
  const q = pending.test.qValue ?? 1;

  if (q <= thresholds.qEstablished) {
    if (sign !== claimed) return { verdict: "buried", cause: "reversed", doubt: null };
    const ltoSign = pending.ltoDiff === null ? sign : signOf(pending.ltoDiff);
    if (pending.ltoP !== null && (pending.ltoP >= thresholds.leaveTopOutKill || ltoSign !== sign)) {
      return { verdict: "buried", cause: "outlier_driven", doubt: null };
    }
    if (pending.strataFlipped) return { verdict: "questionable", cause: null, doubt: "confounded" };
    if (pending.halvesAgree === false)
      return { verdict: "questionable", cause: null, doubt: "unstable" };
    if (pending.ltoP !== null && pending.ltoP >= thresholds.leaveTopOutWeak) {
      return { verdict: "questionable", cause: null, doubt: "outlier_sensitive" };
    }
    return { verdict: "established", cause: null, doubt: null };
  }

  const rawSign = pending.rawDiff === null ? 0 : signOf(pending.rawDiff);
  if (
    pending.rawP !== null &&
    pending.rawP < thresholds.pRaw &&
    rawSign === claimed &&
    p >= thresholds.pWeak
  ) {
    return { verdict: "buried", cause: "time_confound", doubt: null };
  }
  if (p < thresholds.pRaw) {
    // Leaning the other way without surviving correction is not proof of the opposite.
    if (sign !== claimed) return { verdict: "insufficient", cause: null, doubt: null };
    if (pending.ltoP !== null && pending.ltoP >= thresholds.leaveTopOutKill) {
      return { verdict: "buried", cause: "outlier_driven", doubt: null };
    }
    return { verdict: "buried", cause: "multiple_comparisons", doubt: null };
  }
  if (p < thresholds.pWeak && sign === claimed)
    return { verdict: "questionable", cause: null, doubt: "weak" };

  // Not significant: either the groups really look alike, or we cannot tell yet.
  if (pending.numeric) {
    const rho = Math.abs(pending.diff);
    return rho < thresholds.noEffectRho && pending.test.nWith >= 20
      ? { verdict: "buried", cause: "no_effect", doubt: null }
      : { verdict: "insufficient", cause: null, doubt: null };
  }
  const band = pending.kind === "rate" ? thresholds.noEffectPoints : thresholds.noEffectLog2;
  const low = pending.ciLowRaw ?? -Infinity;
  const high = pending.ciHighRaw ?? Infinity;
  if (low > -band && high < band) return { verdict: "buried", cause: "no_effect", doubt: null };
  return { verdict: "insufficient", cause: null, doubt: null };
}

function checksOf(pending: PendingFinding): CheckResult[] {
  const checks: CheckResult[] = [];
  if (pending.insufficient) return checks;
  if (pending.ltoP !== null) {
    const sameSign = pending.ltoDiff !== null && signOf(pending.ltoDiff) === signOf(pending.diff);
    const after = pending.numeric
      ? formatEffect(pending.ltoDiff ?? 0, "correlation")
      : formatEffect(
          effectFromDiff(pending.ltoDiff ?? 0, pending.kind).effect,
          pending.test.effectKind,
        );
    checks.push({
      name: "leave_top_out",
      label: "去掉最火的一篇",
      passed: sameSign && pending.ltoP < thresholds.leaveTopOutWeak,
      detail: `去掉《${pending.ltoTitle ?? "最火的一篇"}》后：${after}，p=${formatP(pending.ltoP)}。`,
    });
  }
  if (pending.rawP !== null) {
    const raw = pending.numeric
      ? formatEffect(pending.rawDiff ?? 0, "correlation")
      : formatEffect(
          effectFromDiff(pending.rawDiff ?? 0, pending.kind).effect,
          pending.test.effectKind,
        );
    checks.push({
      name: "raw_metric",
      label: "不扣除涨粉影响时",
      passed: null,
      detail: `直接比原始数字：${raw}，p=${formatP(pending.rawP)}。`,
    });
  }
  if (pending.halvesDetail) {
    checks.push({
      name: "halves",
      label: "前后两段时间",
      passed: pending.halvesAgree,
      detail: pending.halvesDetail,
    });
  }
  if (pending.strataDetail) {
    checks.push({
      name: "strata",
      label: "分组再看",
      passed: pending.strataFlipped === null ? null : !pending.strataFlipped,
      detail: pending.strataDetail,
    });
  }
  return checks;
}

function evidenceOf(
  pending: PendingFinding,
  verdict: Verdict,
  cause: CauseOfDeath | null,
  perGroup: number | null,
  metricLabel: string,
): string {
  const { test } = pending;
  if (pending.insufficient) {
    if (pending.numeric)
      return `只有 ${test.nWith} 篇有这项数据，至少要 ${thresholds.minNumericPairs} 篇才看得出趋势。`;
    return `一组 ${test.nWith} 篇、另一组 ${test.nWithout} 篇，每组至少要 ${thresholds.minGroup} 篇才能比较。`;
  }
  const q = `校正后 q=${formatP(test.qValue)}`;
  if (pending.numeric) {
    const head = `${test.nWith} 篇里，${formatEffect(pending.diff, "correlation")}（${metricLabel}，已扣除同期水平），${q}。`;
    if (cause === "outlier_driven") return `${head}去掉最火的一篇后趋势消失。`;
    return head;
  }
  const { withLabel } = sideLabel(pending.hypothesis);
  const effect = formatEffect(test.effect ?? 1, test.effectKind);
  const interval =
    test.ciLow !== null && test.ciHigh !== null
      ? `，95% 区间 ${formatEffect(test.ciLow, test.effectKind)} 到 ${formatEffect(test.ciHigh, test.effectKind)}`
      : "";
  const head = `“${withLabel}”的 ${test.nWith} 篇比同期其他 ${test.nWithout} 篇${metricLabel}${effect}${interval}，${q}。`;
  switch (cause) {
    case "outlier_driven":
      return `${head}差异几乎全靠《${pending.ltoTitle ?? "最火的一篇"}》，去掉它后不再显著。`;
    case "time_confound": {
      const raw = formatEffect(
        effectFromDiff(pending.rawDiff ?? 0, pending.kind).effect,
        test.effectKind,
      );
      return `直接比原始数字${raw}，但和同期内容相比只${effect}，${q}：差异主要来自发布时期不同（比如集中发在涨粉期）。`;
    }
    case "multiple_comparisons":
      return `${head}单看显著，但一起检验了很多条，校正后不算数。`;
    case "reversed":
      return `${head}方向和这条说法相反。`;
    case "no_effect":
      return `${head}两组差别在 ±25% 以内，可以认为没有区别。`;
    default:
      break;
  }
  if (verdict === "insufficient") {
    const claimed = pending.hypothesis.spec.direction === "higher" ? 1 : -1;
    const leansOpposite = signOf(pending.diff) !== claimed && (test.pValue ?? 1) < thresholds.pRaw;
    const lean = leansOpposite ? "数据反而偏向相反方向，但校正后不算数。" : "还看不出结论。";
    return perGroup ? `${head}${lean}大约每组要 ${perGroup} 篇才能判断。` : `${head}${lean}`;
  }
  return head;
}

/** Run every hypothesis through the engine and return judged findings. */
export function runEngine(input: EngineInput): EngineResult {
  const platformDef = getPlatform(input.platform);
  const iterations = input.iterations ?? 2000;
  const exclusionNotes: string[] = [];
  const settled = input.posts.filter((post) => {
    if (!post.publishedAt) return true;
    return daysBetween(post.publishedAt, input.asOf) >= platformDef.maturityDays;
  });
  const excluded = input.posts.length - settled.length;
  if (excluded > 0) {
    exclusionNotes.push(
      `${excluded} 篇发布不满 ${platformDef.maturityDays} 天，数字还在变，没有计入。`,
    );
  }
  const prepared = new Prepared(input.platform, settled, input.labels);
  const warnings: string[] = [];
  if (!prepared.timeAdjusted) {
    warnings.push("有内容缺少发布时间，无法按时间扣除涨粉影响，也无法检查前后两段是否一致。");
  }
  if (settled.length < 30) {
    warnings.push(`只有 ${settled.length} 篇可用，少于 30 篇时大多数说法会是“证据不足”。`);
  }

  const pendings: PendingFinding[] = [];
  const untested: EngineResult["untested"] = [];
  for (const hypothesis of input.hypotheses) {
    const metric =
      hypothesis.metric && metricDef(input.platform, hypothesis.metric)
        ? hypothesis.metric
        : input.metric;
    const result = evaluate(prepared, hypothesis, metric, iterations);
    if ("untested" in result) untested.push({ claim: hypothesis.claim, reason: result.untested });
    else pendings.push(result);
  }

  const tested = pendings.filter(
    (pending) => !pending.insufficient && pending.test.pValue !== null,
  );
  const qValues = benjaminiHochberg(tested.map((pending) => pending.test.pValue as number));
  tested.forEach((pending, index) => {
    pending.test.qValue = qValues[index] ?? null;
  });

  const findings: Finding[] = pendings.map((pending) => {
    const decision = decide(pending);
    const perGroup =
      decision.verdict === "insufficient" || decision.verdict === "questionable"
        ? needed(pending)
        : null;
    const metricLabel = metricDef(input.platform, pending.metric)?.label ?? pending.metric;
    return {
      hypothesis: pending.hypothesis,
      metric: pending.metric,
      verdict: decision.verdict,
      cause: decision.cause,
      doubt: decision.doubt,
      test: pending.test,
      checks: checksOf(pending),
      evidence: evidenceOf(pending, decision.verdict, decision.cause, perGroup, metricLabel),
      neededPerGroup: perGroup,
    };
  });

  return {
    postsUsed: settled.length,
    postsExcluded: excluded,
    exclusionNotes,
    timeAdjusted: prepared.timeAdjusted,
    findings,
    untested,
    warnings,
  };
}
