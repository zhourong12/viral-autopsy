import { getPlatform, type PlatformId } from "../../shared/platforms.js";
import type { ExperimentPlan, Finding, Hypothesis } from "../../shared/schemas.js";
import { categoryValueLabel } from "./features.js";

const variants: Record<string, [string, string]> = {
  titleHasNumber: ["标题里放一个具体数字", "标题里不放数字"],
  titleQuestion: ["标题写成问句", "标题写成陈述句"],
  titleExclaim: ["标题结尾加感叹号", "标题不加感叹号"],
  titleEmoji: ["标题里加一个表情", "标题里不加表情"],
  titleFirstPerson: ["标题用“我”讲自己的事", "标题不用第一人称"],
  titleBrackets: ["标题开头加【】标签", "标题不加【】"],
  titleHype: ["标题用一个夸张词", "标题保持平实"],
  titleList: ["标题写成清单体（N 个、N 种）", "标题不用清单体"],
  titleHashtag: ["标题带话题标签", "标题不带话题标签"],
  weekend: ["周末发", "工作日发"],
  evening: ["晚上 18–23 点发", "其他时段发"],
  morning: ["早上 6–9 点发", "其他时段发"],
  isVideo: ["做成视频", "做成图文"],
  isTutorial: ["做成教程干货", "做成非教程内容"],
  emotional: ["表达更强烈的情绪", "语气保持平和"],
  personalStory: ["讲自己的亲身经历", "不讲个人经历"],
  coverFace: ["封面露脸", "封面不露脸"],
  coverBigText: ["封面放大字", "封面不放大字"],
};

const timeFeatures = new Set(["weekend", "evening", "morning"]);

function variantsFor(hypothesis: Hypothesis): [string, string] | null {
  const { spec } = hypothesis;
  if (spec.kind === "keywords") {
    const words = spec.keywords.join("、");
    return [`标题带“${words}”之一`, "标题不带这些词"];
  }
  if (spec.kind === "category") {
    const label = categoryValueLabel(spec.feature, spec.equals);
    return [`标题用“${label}”式开头`, `标题不用“${label}”式开头`];
  }
  if (spec.kind === "numeric") {
    return spec.feature === "titleLength" ? ["标题控制在 15 字以内", "标题写到 25 字以上"] : null;
  }
  return variants[spec.feature] ?? null;
}

/** A, B, B, A, A, B, B, A…: balanced so a steady trend does not favour either side. */
export function balancedSchedule(length: number): Array<"A" | "B"> {
  const pattern: Array<"A" | "B"> = ["A", "B", "B", "A"];
  return Array.from({ length }, (_, index) => pattern[index % 4] as "A" | "B");
}

function scheduleLength(finding: Finding): number {
  const smaller = Math.min(finding.test.nWith, finding.test.nWithout);
  const missing =
    finding.neededPerGroup === null ? 4 : Math.max(0, finding.neededPerGroup - smaller);
  const perSide = Math.min(6, Math.max(3, Math.ceil(missing / 2)));
  return perSide * 2;
}

/**
 * Turn promising-but-unproven findings into concrete alternating experiments. At most three,
 * strongest signal first, so the creator is not asked to change everything at once.
 */
export function prescribeExperiments(findings: Finding[], platform: PlatformId): ExperimentPlan[] {
  const platformDef = getPlatform(platform);
  const candidates = findings
    .filter(
      (finding) =>
        finding.hypothesis.controllable &&
        (finding.verdict === "questionable" ||
          (finding.verdict === "insufficient" && finding.test.pValue !== null)),
    )
    .filter((finding) => variantsFor(finding.hypothesis) !== null)
    .sort((a, b) => (a.test.pValue ?? 1) - (b.test.pValue ?? 1))
    .slice(0, 3);

  return candidates.map((finding) => {
    const [variantA, variantB] = variantsFor(finding.hypothesis) as [string, string];
    const schedule = balancedSchedule(scheduleLength(finding));
    const isTime =
      finding.hypothesis.spec.kind === "feature" &&
      timeFeatures.has(finding.hypothesis.spec.feature);
    const order = schedule.join(" ");
    return {
      hypothesisId: finding.hypothesis.id,
      claim: finding.hypothesis.claim,
      schedule,
      variantA,
      variantB,
      instructions: [
        `接下来 ${schedule.length} 篇按这个顺序发：${order}（A＝${variantA}，B＝${variantB}）。`,
        isTime
          ? "内容照常做，只改变发布时间。"
          : "选题、篇幅和发布时段尽量和平时一样，只改变这一处。",
        "同一时间只做一个实验，否则分不清是谁起的作用。",
        `每篇发布满 ${platformDef.maturityDays} 天后，把数据重新导入，再解剖一次。`,
      ],
      reviewAfterDays: platformDef.maturityDays,
    };
  });
}
