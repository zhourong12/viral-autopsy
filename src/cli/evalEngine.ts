import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { platformIds, platforms, type PlatformId } from "../shared/platforms.js";
import type { Hypothesis, Post, PostLabels } from "../shared/schemas.js";
import { runEngine } from "../server/engine/analyze.js";
import { computeFeatures } from "../server/engine/features.js";
import { myths } from "../server/engine/myths.js";
import { generateAccount } from "../server/synth/synth.js";

/**
 * Engine eval without AI: run the myth library over synthetic accounts with planted truth, and
 * compare with the naive analysis creators usually do ("the average is 20% higher").
 *
 *   npm run eval:engine -- --seeds 40
 */

const seedsArg = process.argv.indexOf("--seeds");
const seeds = seedsArg >= 0 ? Number(process.argv[seedsArg + 1]) || 40 : 40;

interface Tally {
  realTotal: number;
  realEstablished: number;
  realSupported: number;
  nullTested: number;
  nullEstablished: number;
  faceTotal: number;
  faceEstablished: number;
  faceTimeConfound: number;
  numberTotal: number;
  numberEstablished: number;
  naiveRealHits: number;
  naiveNullClaims: number;
  naiveNullTotal: number;
  naiveFaceClaims: number;
  naiveNumberClaims: number;
}

function emptyTally(): Tally {
  return {
    realTotal: 0,
    realEstablished: 0,
    realSupported: 0,
    nullTested: 0,
    nullEstablished: 0,
    faceTotal: 0,
    faceEstablished: 0,
    faceTimeConfound: 0,
    numberTotal: 0,
    numberEstablished: 0,
    naiveRealHits: 0,
    naiveNullClaims: 0,
    naiveNullTotal: 0,
    naiveFaceClaims: 0,
    naiveNumberClaims: 0,
  };
}

/** Naive reading: compare plain averages; "20% higher in the claimed direction" counts as true. */
function naiveClaim(
  hypothesis: Hypothesis,
  posts: Post[],
  labels: Record<string, PostLabels>,
  metric: string,
): boolean | null {
  const features = computeFeatures(posts, labels);
  const { spec } = hypothesis;
  if (spec.kind === "numeric" || spec.kind === "keywords") return null;
  const groupA: number[] = [];
  const groupB: number[] = [];
  for (const post of posts) {
    const value = features.get(post.id)?.[spec.feature];
    const metricValue = post.metrics[metric];
    if (value === null || value === undefined || metricValue === null || metricValue === undefined)
      continue;
    const member = spec.kind === "category" ? String(value) === spec.equals : value === true;
    (member ? groupA : groupB).push(metricValue);
  }
  if (groupA.length === 0 || groupB.length === 0) return null;
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const ratio = mean(groupA) / Math.max(1e-9, mean(groupB));
  return spec.direction === "higher" ? ratio >= 1.2 : ratio <= 1 / 1.2;
}

function pct(numerator: number, denominator: number): string {
  return denominator === 0
    ? "—"
    : `${((numerator / denominator) * 100).toFixed(1)}%（${numerator}/${denominator}）`;
}

const started = Date.now();
const byPlatform: Record<string, Tally> = {};
const total = emptyTally();

for (const platform of platformIds as readonly PlatformId[]) {
  const tally = emptyTally();
  const metric = platforms[platform].defaultMetric;
  for (let seed = 1; seed <= seeds; seed += 1) {
    const account = generateAccount({ platform, seed: seed * 7919 + platform.length });
    const result = runEngine({
      platform,
      posts: account.posts,
      labels: account.labels,
      metric,
      hypotheses: myths,
      asOf: account.asOf,
    });
    for (const finding of result.findings) {
      const id = finding.hypothesis.id;
      const isReal = account.truth.real.includes(id);
      if (isReal) {
        tally.realTotal += 1;
        if (finding.verdict === "established") tally.realEstablished += 1;
        if (finding.verdict === "established" || finding.verdict === "questionable")
          tally.realSupported += 1;
      } else if (finding.verdict !== "insufficient" || finding.test.pValue !== null) {
        tally.nullTested += 1;
        if (finding.verdict === "established") tally.nullEstablished += 1;
      }
      if (id === "myth-face") {
        tally.faceTotal += 1;
        if (finding.verdict === "established") tally.faceEstablished += 1;
        if (finding.cause === "time_confound") tally.faceTimeConfound += 1;
      }
      if (id === "myth-number") {
        tally.numberTotal += 1;
        if (finding.verdict === "established") tally.numberEstablished += 1;
      }
    }
    for (const hypothesis of myths) {
      const naiveMetric = hypothesis.metric ?? metric;
      const claim = naiveClaim(hypothesis, account.posts, account.labels, naiveMetric);
      if (claim === null) continue;
      if (account.truth.real.includes(hypothesis.id)) {
        if (claim) tally.naiveRealHits += 1;
      } else {
        tally.naiveNullTotal += 1;
        if (claim) tally.naiveNullClaims += 1;
        if (hypothesis.id === "myth-face" && claim) tally.naiveFaceClaims += 1;
        if (hypothesis.id === "myth-number" && claim) tally.naiveNumberClaims += 1;
      }
    }
  }
  byPlatform[platform] = tally;
  for (const key of Object.keys(total) as Array<keyof Tally>) total[key] += tally[key];
}

const rows = [...Object.entries(byPlatform), ["全部", total] as const].map(([name, tally]) => ({
  平台: name === "全部" ? "全部" : platforms[name as PlatformId].label,
  真规律判为成立: pct(tally.realEstablished, tally.realTotal),
  真规律判为成立或存疑: pct(tally.realSupported, tally.realTotal),
  假说法被判成立: pct(tally.nullEstablished, tally.nullTested),
  露脸陷阱被判成立: pct(tally.faceEstablished, tally.faceTotal),
  露脸陷阱识破为涨粉期: pct(tally.faceTimeConfound, tally.faceTotal),
  爆文陷阱被判成立: pct(tally.numberEstablished, tally.numberTotal),
  直接比平均数_假说法被当真: pct(tally.naiveNullClaims, tally.naiveNullTotal),
  直接比平均数_露脸陷阱被当真: pct(tally.naiveFaceClaims, tally.faceTotal),
}));

console.table(rows);
const establishedTotal = total.realEstablished + total.nullEstablished;
console.log(
  `错误发现率（判为成立的里面有多少是假的）：${pct(total.nullEstablished, establishedTotal)}`,
);
console.log(
  `账号数：${seeds * platformIds.length}，耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`,
);

const outDir = resolve(process.cwd(), "eval-results");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  resolve(outDir, "engine-eval.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      seedsPerPlatform: seeds,
      byPlatform,
      total,
      falseDiscoveryRate: establishedTotal ? total.nullEstablished / establishedTotal : null,
    },
    null,
    2,
  ),
);
