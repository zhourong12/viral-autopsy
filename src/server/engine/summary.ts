import { comparisonText, formatMetric, standoutText } from "../../shared/format.js";
import { getPlatform, metricDef, type PlatformId } from "../../shared/platforms.js";
import type { CauseOfDeath, ExperimentPlan, Finding, StarterReport } from "../../shared/schemas.js";
import { causeLabels } from "../../shared/schemas.js";

export interface VerdictCounts {
  established: number;
  questionable: number;
  insufficient: number;
  buried: number;
}

export function countVerdicts(findings: Finding[]): VerdictCounts {
  const counts: VerdictCounts = { established: 0, questionable: 0, insufficient: 0, buried: 0 };
  for (const finding of findings) counts[finding.verdict] += 1;
  return counts;
}

const burialPriority: CauseOfDeath[] = [
  "time_confound",
  "outlier_driven",
  "reversed",
  "multiple_comparisons",
  "no_effect",
];

/** The burial most worth telling the creator about. */
export function headlineBurial(findings: Finding[]): Finding | null {
  for (const cause of burialPriority) {
    const found = findings.find(
      (finding) => finding.verdict === "buried" && finding.cause === cause,
    );
    if (found) return found;
  }
  return null;
}

export function strongestFinding(findings: Finding[]): Finding | null {
  const established = findings.filter((finding) => finding.verdict === "established");
  established.sort((a, b) => (a.test.qValue ?? 1) - (b.test.qValue ?? 1));
  return established[0] ?? null;
}

/** Deterministic summary. Used as-is without AI, and as the fallback when AI numbers fail. */
export function templateSummary(
  findings: Finding[],
  experiments: ExperimentPlan[],
  postsUsed: number,
  platform: PlatformId,
): string {
  const noun = getPlatform(platform).contentNoun;
  const counts = countVerdicts(findings);
  const parts = [
    `在 ${postsUsed} 篇${noun}里检验了 ${findings.length} 条说法：${counts.established} 条成立，${counts.questionable} 条存疑，${counts.insufficient} 条证据不足，${counts.buried} 条不成立。`,
  ];
  const best = strongestFinding(findings);
  if (best) parts.push(`最可靠的发现是“${best.hypothesis.claim}”：${best.evidence}`);
  else parts.push("目前没有一条说法能通过全部检验，这在几十篇的样本里很常见。");
  const burial = headlineBurial(findings);
  if (burial?.cause) {
    parts.push(
      `最该放下的说法是“${burial.hypothesis.claim}”，死因：${causeLabels[burial.cause]}。`,
    );
  }
  const first = experiments[0];
  if (first) {
    parts.push(`下一步可以先验证“${first.claim}”：接下来 ${first.schedule.length} 篇交替尝试。`);
  }
  return parts.join("");
}

/** Summary for a new account: what it can and cannot say yet, the standout post, the next step. */
export function starterSummary(
  starter: StarterReport,
  experiments: ExperimentPlan[],
  postsTotal: number,
  platform: PlatformId,
  metric: string,
): string {
  const def = getPlatform(platform);
  const noun = def.contentNoun;
  const metricInfo = metricDef(platform, metric);
  const parts = [
    `现在有 ${postsTotal} 篇${noun}，发布满 ${def.maturityDays} 天的有 ${starter.postsSettled} 篇，还判断不了哪条说法成立：每组至少要 5 篇才能比较，一般要 ${starter.target} 篇左右才看得出稳定的规律。`,
  ];
  const best = starter.checkups.find(
    (item) => !item.settling && item.value !== null && item.typical !== null,
  );
  if (best && metricInfo && best.value !== null && best.typical !== null) {
    const compared = comparisonText(best.value, best.typical, metricInfo.kind);
    let line = `目前${metricInfo.label}最高的是“${best.title}”（${formatMetric(best.value, metricInfo.kind)}${compared ? `，${compared}` : ""}）`;
    const lead = best.standouts[0];
    if (lead) line += `，和别的${noun}最不一样的是${standoutText(lead)}`;
    parts.push(`${line}。这只是描述，不代表规律。`);
  }
  const first = experiments[0];
  if (first) {
    parts.push(
      `与其等篇数攒够，不如主动验证：先做“${first.claim}”，接下来 ${first.schedule.length} 篇按顺序交替发，同一时间只做这一个。`,
    );
  }
  return parts.join("");
}
