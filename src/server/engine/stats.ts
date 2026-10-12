/**
 * Small, dependency-free statistics: robust location, permutation tests, bootstrap intervals,
 * Spearman correlation and Benjamini–Hochberg. Every random step takes a seeded generator so a
 * report is reproducible.
 */

export type Rng = () => number;

/** Mulberry32: tiny, fast and good enough for resampling. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function quickselect(values: number[], k: number): number {
  let left = 0;
  let right = values.length - 1;
  while (right > left) {
    const pivot = values[(left + right) >> 1] as number;
    let i = left;
    let j = right;
    while (i <= j) {
      while ((values[i] as number) < pivot) i += 1;
      while ((values[j] as number) > pivot) j -= 1;
      if (i <= j) {
        const tmp = values[i] as number;
        values[i] = values[j] as number;
        values[j] = tmp;
        i += 1;
        j -= 1;
      }
    }
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else break;
  }
  return values[k] as number;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const copy = values.slice();
  const mid = copy.length >> 1;
  const upper = quickselect(copy, mid);
  if (copy.length % 2 === 1) return upper;
  let lower = -Infinity;
  for (let i = 0; i < mid; i += 1) if ((copy[i] as number) > lower) lower = copy[i] as number;
  return (lower + upper) / 2;
}

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;
  const low = sorted[base] as number;
  const high = sorted[Math.min(base + 1, sorted.length - 1)] as number;
  return low + rest * (high - low);
}

/** Median absolute deviation scaled to match the standard deviation under normality. */
export function robustSd(values: readonly number[]): number {
  if (values.length < 2) return Number.NaN;
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center))) * 1.4826;
  if (mad > 0) return mad;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export interface TwoSampleResult {
  diff: number;
  pValue: number;
}

/** Two-sided permutation test on the difference of medians (a − b). */
export function permutationMedianTest(
  a: readonly number[],
  b: readonly number[],
  rng: Rng,
  iterations = 2000,
): TwoSampleResult {
  const observed = median(a) - median(b);
  const pooled = [...a, ...b];
  const na = a.length;
  const scratch = pooled.slice();
  let extreme = 0;
  const tolerance = 1e-12;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    // Partial Fisher–Yates: only the first `na` slots need to be random.
    for (let i = 0; i < na; i += 1) {
      const j = i + Math.floor(rng() * (scratch.length - i));
      const tmp = scratch[i] as number;
      scratch[i] = scratch[j] as number;
      scratch[j] = tmp;
    }
    const diff = median(scratch.slice(0, na)) - median(scratch.slice(na));
    if (Math.abs(diff) >= Math.abs(observed) - tolerance) extreme += 1;
  }
  return { diff: observed, pValue: (extreme + 1) / (iterations + 1) };
}

/** Percentile bootstrap interval for the difference of medians, resampling within each group. */
export function bootstrapMedianDiffCi(
  a: readonly number[],
  b: readonly number[],
  rng: Rng,
  iterations = 1500,
  level = 0.95,
): [number, number] {
  const diffs: number[] = [];
  const sampleA = new Array<number>(a.length);
  const sampleB = new Array<number>(b.length);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let i = 0; i < a.length; i += 1) sampleA[i] = a[Math.floor(rng() * a.length)] as number;
    for (let i = 0; i < b.length; i += 1) sampleB[i] = b[Math.floor(rng() * b.length)] as number;
    diffs.push(median(sampleA) - median(sampleB));
  }
  diffs.sort((x, y) => x - y);
  const tail = (1 - level) / 2;
  return [quantile(diffs, tail), quantile(diffs, 1 - tail)];
}

function ranks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((x, y) => x.value - y.value);
  const result = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (
      j + 1 < order.length &&
      (order[j + 1] as { value: number }).value === (order[i] as { value: number }).value
    )
      j += 1;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) result[(order[k] as { index: number }).index] = averageRank;
    i = j + 1;
  }
  return result;
}

function pearson(x: readonly number[], y: readonly number[]): number {
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (x[i] as number) - mx;
    const dy = (y[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

export function spearman(x: readonly number[], y: readonly number[]): number {
  return pearson(ranks(x), ranks(y));
}

/** Two-sided permutation test for Spearman's rho. */
export function permutationSpearmanTest(
  x: readonly number[],
  y: readonly number[],
  rng: Rng,
  iterations = 2000,
): { rho: number; pValue: number } {
  const rx = ranks(x);
  const ry = ranks(y);
  const observed = pearson(rx, ry);
  const shuffled = ry.slice();
  let extreme = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = shuffled[i] as number;
      shuffled[i] = shuffled[j] as number;
      shuffled[j] = tmp;
    }
    if (Math.abs(pearson(rx, shuffled)) >= Math.abs(observed) - 1e-12) extreme += 1;
  }
  return { rho: observed, pValue: (extreme + 1) / (iterations + 1) };
}

/** Benjamini–Hochberg adjusted p-values (q-values), returned in input order. */
export function benjaminiHochberg(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, index) => ({ p, index })).sort((x, y) => x.p - y.p);
  const q = new Array<number>(m);
  let running = 1;
  for (let rank = m; rank >= 1; rank -= 1) {
    const item = order[rank - 1] as { p: number; index: number };
    running = Math.min(running, (item.p * m) / rank);
    q[item.index] = Math.min(1, running);
  }
  return q;
}

/**
 * Posts per group needed to detect a difference `delta` in medians with ~80% power at a
 * two-sided 5% level, for data with spread `sd`. Uses the normal approximation inflated by
 * π/2, the efficiency loss of comparing medians instead of means.
 */
export function neededPerGroup(sd: number, delta: number): number {
  if (!(sd > 0) || !(delta > 0)) return Number.NaN;
  const z = 1.96 + 0.8416;
  return Math.ceil(((2 * z * z * sd * sd) / (delta * delta)) * (Math.PI / 2));
}
