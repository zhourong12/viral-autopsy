import { getPlatform, type PlatformId } from "../../shared/platforms.js";
import type { CauseOfDeath, ExperimentPlan, Finding } from "../../shared/schemas.js";
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
