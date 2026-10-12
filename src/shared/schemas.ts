import { z } from "zod";
import { platformIds } from "./platforms.js";

export const PlatformIdSchema = z.enum(platformIds);

export const contentFormats = ["video", "image", "article"] as const;
export const ContentFormatSchema = z.enum(contentFormats);
export type ContentFormat = z.infer<typeof ContentFormatSchema>;

/** One published piece of content and its numbers, after the user confirmed the import. */
export const PostSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(500),
  /** ISO timestamp; null when the source had no usable date. */
  publishedAt: z.string().nullable(),
  format: ContentFormatSchema.nullable(),
  metrics: z.record(z.string(), z.number().finite().nullable()),
  url: z.string().max(2000).nullable().default(null),
});
export type Post = z.infer<typeof PostSchema>;

export const datasetSources = ["file", "screenshot", "paste", "sample"] as const;
export type DatasetSource = (typeof datasetSources)[number];

export interface Dataset {
  id: string;
  platform: z.infer<typeof PlatformIdSchema>;
  accountName: string;
  source: DatasetSource;
  /** Synthetic sample data. Every page that shows it must say so. */
  isSample: boolean;
  posts: Post[];
  /** Per-post labels: rule features are recomputed, AI and user labels are stored. */
  labels: Record<string, PostLabels>;
  labelSource: "none" | "ai" | "user";
  createdAt: string;
  /** Date the numbers were read; maturity is measured against it. */
  asOf: string;
  importNotes: string[];
}

// ---------------------------------------------------------------------------
// Labels (AI or user). Rule-based features are derived in code, not stored.

export const hookTypes = [
  "question",
  "number",
  "contrarian",
  "emotion",
  "tutorial",
  "story",
  "list",
  "other",
] as const;
export const HookTypeSchema = z.enum(hookTypes);
export type HookType = z.infer<typeof HookTypeSchema>;

export const hookTypeLabels: Record<HookType, string> = {
  question: "提问",
  number: "数字",
  contrarian: "反常识",
  emotion: "情绪",
  tutorial: "教程",
  story: "故事",
  list: "清单",
  other: "其他",
};

export const PostLabelsSchema = z.object({
  hookType: HookTypeSchema.nullable(),
  /** Short topic name, 2–8 characters, shared across posts on the same subject. */
  topic: z.string().max(20).nullable(),
  isTutorial: z.boolean().nullable(),
  emotional: z.boolean().nullable(),
  personalStory: z.boolean().nullable(),
  /** Cover attributes are null unless the cover was visible to the model. */
  coverFace: z.boolean().nullable(),
  coverBigText: z.boolean().nullable(),
});
export type PostLabels = z.infer<typeof PostLabelsSchema>;

export const emptyLabels: PostLabels = {
  hookType: null,
  topic: null,
  isTutorial: null,
  emotional: null,
  personalStory: null,
  coverFace: null,
  coverBigText: null,
};

// ---------------------------------------------------------------------------
// Hypotheses: what the engine can test. AI proposals must fit this shape.

export const directions = ["higher", "lower"] as const;
export const DirectionSchema = z.enum(directions);
export type Direction = z.infer<typeof DirectionSchema>;

export const HypothesisSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("feature"),
    /** Key of a binary feature (rule or label). */
    feature: z.string().min(1).max(40),
    direction: DirectionSchema,
  }),
  z.object({
    kind: z.literal("category"),
    /** Key of a category feature, e.g. hookType or topic. */
    feature: z.string().min(1).max(40),
    equals: z.string().min(1).max(40),
    direction: DirectionSchema,
  }),
  z.object({
    kind: z.literal("keywords"),
    /** Posts whose title contains any of these words. */
    keywords: z.array(z.string().min(1).max(12)).min(1).max(8),
    direction: DirectionSchema,
  }),
  z.object({
    kind: z.literal("numeric"),
    /** Key of a numeric feature, e.g. titleLength or publishHour. */
    feature: z.string().min(1).max(40),
    direction: DirectionSchema,
  }),
]);
export type HypothesisSpec = z.infer<typeof HypothesisSpecSchema>;

export type HypothesisOrigin = "myth" | "ai";

export interface Hypothesis {
  id: string;
  origin: HypothesisOrigin;
  /** Plain-language claim shown to the user. */
  claim: string;
  spec: HypothesisSpec;
  /** Metric key to test on; defaults to the dataset's chosen metric. */
  metric: string | null;
  /** True when the feature can be changed on purpose, so an experiment makes sense. */
  controllable: boolean;
  /** Why the AI proposed it (AI hypotheses only). */
  rationale?: string;
}

// ---------------------------------------------------------------------------
// Engine results.

export const verdicts = ["established", "questionable", "insufficient", "buried"] as const;
export type Verdict = (typeof verdicts)[number];

export const verdictLabels: Record<Verdict, string> = {
  established: "成立",
  questionable: "存疑",
  insufficient: "证据不足",
  buried: "不成立",
};

export const causesOfDeath = [
  "outlier_driven",
  "time_confound",
  "multiple_comparisons",
  "reversed",
  "no_effect",
] as const;
export type CauseOfDeath = (typeof causesOfDeath)[number];

export const causeLabels: Record<CauseOfDeath, string> = {
  outlier_driven: "一篇爆文撑起来的",
  time_confound: "其实是涨粉期的功劳",
  multiple_comparisons: "同时检验太多条，侥幸显著",
  reversed: "在你的数据里正好相反",
  no_effect: "两组几乎没有差别",
};

export const doubtReasons = ["confounded", "unstable", "weak", "outlier_sensitive"] as const;
export type DoubtReason = (typeof doubtReasons)[number];

export const doubtLabels: Record<DoubtReason, string> = {
  confounded: "和其他因素混在一起，分开看方向不一致",
  unstable: "前后两段时间方向不一致",
  weak: "有点苗头，但证据还不够",
  outlier_sensitive: "去掉最火的一篇后明显变弱",
};

export interface CheckResult {
  name: "leave_top_out" | "halves" | "strata" | "raw_metric";
  label: string;
  passed: boolean | null;
  detail: string;
}

export interface TestOutcome {
  /** Posts in the "feature present" group and the comparison group. */
  nWith: number;
  nWithout: number;
  /** Medians of the metric itself, for display. */
  medianWith: number | null;
  medianWithout: number | null;
  /**
   * Effect on relative performance. For count metrics, a ratio (1.38 = 38% higher than nearby
   * posts would predict); for rates, a difference in percentage points.
   */
  effect: number | null;
  effectKind: "ratio" | "points" | "correlation";
  ciLow: number | null;
  ciHigh: number | null;
  pValue: number | null;
  qValue: number | null;
}

export interface Finding {
  hypothesis: Hypothesis;
  metric: string;
  verdict: Verdict;
  cause: CauseOfDeath | null;
  doubt: DoubtReason | null;
  test: TestOutcome;
  checks: CheckResult[];
  /** Deterministic one-line explanation with the numbers. */
  evidence: string;
  /** Posts per group needed to judge it; null when not computed. */
  neededPerGroup: number | null;
}

export interface ExperimentPlan {
  hypothesisId: string;
  claim: string;
  /** Sequence like ["A", "B", "A", "B", …]; A means "with the feature". */
  schedule: Array<"A" | "B">;
  variantA: string;
  variantB: string;
  instructions: string[];
  reviewAfterDays: number;
}

export type AnalysisMode = "ai" | "rules_only";

export interface UsageSummary {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

export interface AnalysisReport {
  id: string;
  datasetId: string;
  platform: z.infer<typeof PlatformIdSchema>;
  accountName: string;
  isSample: boolean;
  mode: AnalysisMode;
  metric: string;
  metricLabel: string;
  createdAt: string;
  /** Posts analysed after dropping unsettled ones, and the ones dropped. */
  postsUsed: number;
  postsExcluded: number;
  exclusionNotes: string[];
  findings: Finding[];
  /** Hypotheses that could not be tested at all, with the reason (e.g. labels missing). */
  untested: Array<{ claim: string; reason: string }>;
  experiments: ExperimentPlan[];
  /** Plain-language summary. AI-written only when every number in it checks out. */
  summary: string;
  summarySource: "ai" | "template";
  /** Numbers the AI used that the engine could not find; empty when clean. */
  unverifiedNumbers: string[];
  /** The AI playing devil's advocate: other explanations worth ruling out, without numbers. */
  alternatives: Array<{ hypothesisId: string; text: string }>;
  usage: UsageSummary[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// API inputs.

export const ImportFileRequestSchema = z.object({
  platform: PlatformIdSchema,
  accountName: z.string().trim().min(1).max(40),
  fileName: z.string().max(200),
  /** CSV/TSV text, or base64 for .xlsx. */
  content: z.string().min(1).max(15_000_000),
  encoding: z.enum(["text", "base64"]),
});

export const ImportPasteRequestSchema = z.object({
  platform: PlatformIdSchema,
  accountName: z.string().trim().min(1).max(40),
  text: z.string().min(1).max(2_000_000),
});

export const ScreenshotRequestSchema = z.object({
  platform: PlatformIdSchema,
  accountName: z.string().trim().min(1).max(40),
  images: z
    .array(
      z.object({
        mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
        data: z.string().min(1).max(8_000_000),
      }),
    )
    .min(1)
    .max(10),
});

export const ConfirmRowsRequestSchema = z.object({
  posts: z.array(PostSchema).min(1).max(1000),
});

export const UpdateLabelsRequestSchema = z.object({
  labels: z.record(z.string(), PostLabelsSchema),
});

export const AnalyzeRequestSchema = z.object({
  datasetId: z.string().min(1),
  metric: z.string().min(1).max(40).optional(),
  useAi: z.boolean().default(true),
});
