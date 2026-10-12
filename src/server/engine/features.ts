import type { Post, PostLabels } from "../../shared/schemas.js";
import { hookTypeLabels } from "../../shared/schemas.js";

export type FeatureValue = boolean | number | string | null;
export type FeatureKind = "binary" | "numeric" | "category";

export interface FeatureDef {
  key: string;
  label: string;
  kind: FeatureKind;
  /** "rule" features come from the title and publish time; "label" ones from AI or the user. */
  source: "rule" | "label";
  /** Whether a creator can choose it on purpose, which makes an experiment possible. */
  controllable: boolean;
  compute(post: Post, labels: PostLabels | undefined): FeatureValue;
}

const numberPattern =
  /\d|[一二两三四五六七八九十百千]+\s*(?:个|种|步|天|招|件|条|款|年|月|周|分钟|小时|次|块|元)/;
const questionPattern = /[?？]|为什么|为啥|怎么|如何|哪些|哪个|是不是|有没有|能不能|该不该|吗$|呢$/;
const hypePattern =
  /绝了|天花板|保姆级|必看|干货|全网|yyds|封神|一定要|千万别|千万不要|狠狠|救命|太香了|宝藏|神仙|绝绝子|爆款|震惊|ultimate|insane|must[- ]?see|game[- ]?changer/i;
const listPattern =
  /\d+\s*(?:个|种|款|件|条|招|步|点|样|类)|top\s*\d+|\d+\s*(?:ways|tips|things|ideas|reasons)/i;
const emojiPattern = /\p{Extended_Pictographic}/u;

function titleChars(title: string): number {
  return Array.from(title.replace(/\s+/g, "").replace(/\p{Extended_Pictographic}|️/gu, "")).length;
}

/** Hour and weekday from a local "YYYY-MM-DDTHH:mm" string; hour is null for date-only values. */
export function timeParts(publishedAt: string | null): { day: number | null; hour: number | null } {
  if (!publishedAt) return { day: null, hour: null };
  const [datePart, timePart] = publishedAt.split("T");
  const [year, month, dayOfMonth] = (datePart ?? "").split("-").map(Number);
  if (!year || !month || !dayOfMonth) return { day: null, hour: null };
  const day = new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay();
  const hour = timePart ? Number(timePart.slice(0, 2)) : null;
  return { day, hour: hour === null || Number.isNaN(hour) ? null : hour };
}

function hourIn(post: Post, from: number, to: number): boolean | null {
  const { hour } = timeParts(post.publishedAt);
  if (hour === null) return null;
  return hour >= from && hour <= to;
}

function labelBool(labels: PostLabels | undefined, key: keyof PostLabels): boolean | null {
  const value = labels?.[key];
  return typeof value === "boolean" ? value : null;
}

export const featureDefs: FeatureDef[] = [
  {
    key: "titleHasNumber",
    label: "标题带数字",
    kind: "binary",
    source: "rule",
    controllable: true,
    compute: (post) => numberPattern.test(post.title),
  },
  {
    key: "titleQuestion",
    label: "标题是问句",
    kind: "binary",
    source: "rule",
    controllable: true,
    compute: (post) => questionPattern.test(post.title),
  },
  {
    key: "titleExclaim",
    label: "标题带感叹号",
    kind: "binary",
    source: "rule",
    controllable: true,
    compute: (post) => /[!！]/.test(post.title),
  },
  {
    key: "titleEmoji",
    label: "标题带表情",
    kind: "binary",
    source: "rule",
    controllable: true,
    compute: (post) => emojiPattern.test(post.title),
  },
  {
    key: "titleFirstPerson",
    label: "标题用第一人称",
    kind: "binary",
    source: "rule",
    controllable: true,
    compute: (post) => /我|\b(?:I|my|me)\b/.test(post.title),
  },
  {
    key: "titleBrackets",
    label: "标题带【】",
    kind: "binary",
    source: "rule",
    controllable: true,
    compute: (post) => /[【】[\]「」『』]/.test(post.title),
  },
  {
    key: "titleHype",
    label: "标题有夸张词",
    kind: "binary",
    source: "rule",
    controllable: true,
    compute: (post) => hypePattern.test(post.title),
  },
  {
    key: "titleList",
    label: "清单体标题",
    kind: "binary",
    source: "rule",
    controllable: true,
    compute: (post) => listPattern.test(post.title),
  },
  {
    key: "titleHashtag",
    label: "标题带话题标签",
    kind: "binary",
    source: "rule",
    controllable: true,
    compute: (post) => /#\S/.test(post.title),
  },
  {
    key: "titleLength",
    label: "标题字数",
    kind: "numeric",
    source: "rule",
    controllable: true,
    compute: (post) => (post.title ? titleChars(post.title) : null),
  },
  {
    key: "weekend",
    label: "周末发布",
    kind: "binary",
    source: "rule",
    controllable: true,
    compute: (post) => {
      const { day } = timeParts(post.publishedAt);
      return day === null ? null : day === 0 || day === 6;
    },
  },
  {
    key: "evening",
    label: "晚上发布（18–23 点）",
    kind: "binary",
    source: "rule",
    controllable: true,
    compute: (post) => hourIn(post, 18, 23),
  },
  {
    key: "morning",
    label: "早上发布（6–9 点）",
    kind: "binary",
    source: "rule",
    controllable: true,
    compute: (post) => hourIn(post, 6, 9),
  },
  {
    key: "publishHour",
    label: "发布时刻",
    kind: "numeric",
    source: "rule",
    controllable: true,
    compute: (post) => timeParts(post.publishedAt).hour,
  },
  {
    key: "isVideo",
    label: "视频（相对图文）",
    kind: "binary",
    source: "rule",
    controllable: true,
    compute: (post) => (post.format === null ? null : post.format === "video"),
  },
  {
    key: "isTutorial",
    label: "教程干货类",
    kind: "binary",
    source: "label",
    controllable: true,
    compute: (_post, labels) => labelBool(labels, "isTutorial"),
  },
  {
    key: "emotional",
    label: "强情绪表达",
    kind: "binary",
    source: "label",
    controllable: true,
    compute: (_post, labels) => labelBool(labels, "emotional"),
  },
  {
    key: "personalStory",
    label: "讲个人经历",
    kind: "binary",
    source: "label",
    controllable: true,
    compute: (_post, labels) => labelBool(labels, "personalStory"),
  },
  {
    key: "coverFace",
    label: "封面露脸",
    kind: "binary",
    source: "label",
    controllable: true,
    compute: (_post, labels) => labelBool(labels, "coverFace"),
  },
  {
    key: "coverBigText",
    label: "封面大字",
    kind: "binary",
    source: "label",
    controllable: true,
    compute: (_post, labels) => labelBool(labels, "coverBigText"),
  },
  {
    key: "hookType",
    label: "标题钩子",
    kind: "category",
    source: "label",
    controllable: true,
    compute: (_post, labels) => labels?.hookType ?? null,
  },
  {
    key: "topic",
    label: "选题",
    kind: "category",
    source: "label",
    controllable: false,
    compute: (_post, labels) => labels?.topic?.trim() || null,
  },
];

const byKey = new Map(featureDefs.map((def) => [def.key, def]));

export function getFeature(key: string): FeatureDef | undefined {
  return byKey.get(key);
}

export function categoryValueLabel(feature: string, value: string): string {
  if (feature === "hookType" && value in hookTypeLabels) {
    return hookTypeLabels[value as keyof typeof hookTypeLabels];
  }
  return value;
}

export type FeatureTable = Map<string, Record<string, FeatureValue>>;

/** Every feature for every post. Label features are null until labels exist. */
export function computeFeatures(posts: Post[], labels: Record<string, PostLabels>): FeatureTable {
  const table: FeatureTable = new Map();
  for (const post of posts) {
    const row: Record<string, FeatureValue> = {};
    for (const def of featureDefs) row[def.key] = def.compute(post, labels[post.id]);
    table.set(post.id, row);
  }
  return table;
}

/** Summary used to tell the AI which features are worth proposing hypotheses about. */
export function featureCoverage(table: FeatureTable): Array<{
  key: string;
  label: string;
  kind: FeatureKind;
  present: number;
  absent: number;
  values?: string[];
}> {
  const rows = [...table.values()];
  return featureDefs.map((def) => {
    const values = rows
      .map((row) => row[def.key])
      .filter((value) => value !== null && value !== undefined);
    if (def.kind === "binary") {
      const present = values.filter((value) => value === true).length;
      return {
        key: def.key,
        label: def.label,
        kind: def.kind,
        present,
        absent: values.length - present,
      };
    }
    if (def.kind === "category") {
      const distinct = [...new Set(values.map(String))];
      return {
        key: def.key,
        label: def.label,
        kind: def.kind,
        present: values.length,
        absent: rows.length - values.length,
        values: distinct.slice(0, 30),
      };
    }
    return {
      key: def.key,
      label: def.label,
      kind: def.kind,
      present: values.length,
      absent: rows.length - values.length,
    };
  });
}
