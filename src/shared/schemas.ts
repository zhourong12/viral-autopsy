import { z } from "zod";
import { platformIds, type MetricKind } from "./platforms.js";

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
  /**
   * "signal": the account's own data leans this way but is not conclusive. "starter": a new
   * account has too few posts for any signal, so this is a common claim worth testing first.
   * Missing on plans saved before starter experiments existed, which were all signals.
   */
  basis?: "signal" | "starter";
  /** The claim's full definition, needed to judge the experiment when it has no finding. */
  hypothesis?: Hypothesis;
  /** Sequence like ["A", "B", "A", "B", …]; A means "with the feature". */
  schedule: Array<"A" | "B">;
  variantA: string;
  variantB: string;
  instructions: string[];
  reviewAfterDays: number;
}

export const experimentOutcomes = [
  "supported",
  "not_supported",
  "inconclusive",
  "waiting",
] as const;
export type ExperimentOutcome = (typeof experimentOutcomes)[number];

export const experimentOutcomeLabels: Record<ExperimentOutcome, string> = {
  supported: "实验支持",
  not_supported: "实验不支持",
  inconclusive: "还看不出",
  waiting: "等待数据",
};

export interface ExperimentRow {
  postId: string;
  title: string;
  publishedAt: string | null;
  /** What the schedule asked for at this position. */
  planned: "A" | "B" | null;
  /** What the post actually was, read from its title and labels; null when unknown. */
  actual: "A" | "B" | null;
  /** True when the actual side was unknown and the planned side was assumed. */
  assumed: boolean;
  /** Settled long enough to count. */
  mature: boolean;
  /** Performance relative to nearby posts, as a ratio (counts) or points (rates). */
  relative: number | null;
}

export interface ExperimentResult {
  evaluatedAt: string;
  datasetId: string;
  outcome: ExperimentOutcome;
  message: string;
  nA: number;
  nB: number;
  nImmature: number;
  effect: number | null;
  effectKind: "ratio" | "points";
  ciLow: number | null;
  ciHigh: number | null;
  pValue: number | null;
  /** Posts whose actual side matched the schedule, out of posts with a known side. */
  followed: number;
  known: number;
  rows: ExperimentRow[];
}

export type ExperimentStatus = "running" | "finished" | "abandoned";

export interface ExperimentRecord {
  id: string;
  platform: z.infer<typeof PlatformIdSchema>;
  accountName: string;
  sourceReportId: string | null;
  hypothesis: Hypothesis;
  plan: ExperimentPlan;
  metric: string;
  metricLabel: string;
  /** YYYY-MM-DD: posts published on or after this day belong to the experiment. */
  startedOn: string;
  status: ExperimentStatus;
  result: ExperimentResult | null;
  createdAt: string;
  updatedAt: string;
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

/** A metric where one post differs clearly from the account's typical post. */
export interface Standout {
  metric: string;
  label: string;
  kind: MetricKind;
  value: number;
  /** Median of the account's other settled posts. */
  typical: number;
}

export interface PostCheckup {
  postId: string;
  title: string;
  publishedAt: string | null;
  /** Published too recently for its numbers to have settled; not used as a baseline. */
  settling: boolean;
  /** The report's metric, and the median of the account's other settled posts. */
  value: number | null;
  typical: number | null;
  /** Other metrics where this post differs clearly from the typical post, biggest first. */
  standouts: Standout[];
}

/** Added to reports on accounts too small for the engine to judge claims. */
export interface StarterReport {
  postsSettled: number;
  /** Settled posts at which the starter view stops being added. */
  target: number;
  /** Highest value of the report's metric first. */
  checkups: PostCheckup[];
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
  /** Per-post checkup for new accounts; null on larger ones, missing on older reports. */
  starter?: StarterReport | null;
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

/**
 * Which field each column of an imported table holds. Field ids: "title", "publishedAt",
 * "format", "url", or "metric:<key>"; null means "ignore this column".
 */
export const ColumnAssignmentSchema = z.object({
  headerRow: z.number().int().min(0).max(9),
  columns: z.array(z.string().max(60).nullable()).max(300),
});
export type ColumnAssignment = z.infer<typeof ColumnAssignmentSchema>;

export const UploadedFileSchema = z.object({
  fileName: z.string().max(200),
  /** CSV/TSV text, or base64 for any file. */
  content: z.string().min(1).max(15_000_000),
  encoding: z.enum(["text", "base64"]),
});
export type UploadedFile = z.infer<typeof UploadedFileSchema>;

/** One table, or several files that each hold one post's own export. */
const UploadedFilesSchema = z.array(UploadedFileSchema).min(1).max(100);

export const ImportFileRequestSchema = z.object({
  platform: PlatformIdSchema,
  accountName: z.string().trim().min(1).max(40),
  files: UploadedFilesSchema,
  assignment: ColumnAssignmentSchema.optional(),
});

export const ImportPasteRequestSchema = z.object({
  platform: PlatformIdSchema,
  accountName: z.string().trim().min(1).max(40),
  text: z.string().min(1).max(2_000_000),
  assignment: ColumnAssignmentSchema.optional(),
});

export const ImportPreviewRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    platform: PlatformIdSchema,
    files: UploadedFilesSchema,
    assignment: ColumnAssignmentSchema.optional(),
  }),
  z.object({
    kind: z.literal("paste"),
    platform: PlatformIdSchema,
    text: z.string().min(1).max(2_000_000),
    assignment: ColumnAssignmentSchema.optional(),
  }),
]);

/** A table read through column mapping. */
export interface TableImportPreview {
  kind: "table";
  headerRow: number;
  headers: string[];
  assignment: ColumnAssignment;
  /** True when there is a title column and at least one metric column. */
  complete: boolean;
  /** What is still missing, in plain language. */
  missing: string[];
  /** The assignment came from a mapping the user saved for these exact headers. */
  fromSaved: boolean;
  /** First data rows as text, aligned with headers, so the user can see what each column holds. */
  samples: string[][];
  /** First parsed posts with the current assignment (empty when incomplete). */
  posts: Post[];
  dataRows: number;
  notes: string[];
  fields: Array<{ id: string; label: string }>;
}

/** Files that each hold one post's export, such as Xiaohongshu's single-note download. */
export interface PostsImportPreview {
  kind: "posts";
  posts: Post[];
  notes: string[];
}

export type ImportPreview = TableImportPreview | PostsImportPreview;

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

export const StartExperimentRequestSchema = z.object({
  reportId: z.string().min(1),
  hypothesisId: z.string().min(1).max(64),
  /** Defaults to today. */
  startedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const EvaluateExperimentRequestSchema = z.object({
  datasetId: z.string().min(1),
});

export const UpdateExperimentRequestSchema = z.object({
  status: z.enum(["running", "finished", "abandoned"]),
});

export const AnalyzeRequestSchema = z.object({
  datasetId: z.string().min(1),
  metric: z.string().min(1).max(40).optional(),
  useAi: z.boolean().default(true),
});
