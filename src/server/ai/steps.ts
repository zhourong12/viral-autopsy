import { getPlatform, metricDef, type PlatformId } from "../../shared/platforms.js";
import type {
  Finding,
  Hypothesis,
  HypothesisSpec,
  Post,
  PostLabels,
  UsageSummary,
} from "../../shared/schemas.js";
import { HypothesisSpecSchema, emptyLabels, verdictLabels } from "../../shared/schemas.js";
import { featureCoverage, getFeature, type FeatureTable } from "../engine/features.js";
import { parseMetricValue, parsePublishedAt } from "../import/values.js";
import { AiError, type StructuredLlm } from "./llm.js";
import {
  HypothesesOutputSchema,
  LabelOutputSchema,
  NarrationOutputSchema,
  extractionSchema,
  extractionSystemPrompt,
  hypothesesSystemPrompt,
  labelSystemPrompt,
  narrationSystemPrompt,
  type NarrationOutput,
} from "./prompts.js";

export interface ScreenshotImage {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  /** Base64 without a data: prefix. */
  data: string;
}

export interface ExtractedRows {
  posts: Post[];
  /** Cover attributes seen in the screenshot, keyed by post id. */
  coverHints: Record<string, Pick<PostLabels, "coverFace" | "coverBigText">>;
  /** Cells the model could not read clearly: post id -> field names. */
  uncertain: Record<string, string[]>;
  notes: string[];
  usage: UsageSummary[];
}

function escapeXml(text: string): string {
  return text.replace(/[<>&]/g, (char) =>
    char === "<" ? "&lt;" : char === ">" ? "&gt;" : "&amp;",
  );
}

/**
 * Screenshots to rows. One call per image (they can be processed in parallel), then rows that
 * appear in two overlapping screenshots are merged. Text-to-number conversion happens here, in
 * code, never in the model.
 */
export async function extractScreenshots(
  llm: StructuredLlm,
  platform: PlatformId,
  images: ScreenshotImage[],
  asOf: string,
): Promise<ExtractedRows> {
  const def = getPlatform(platform);
  const schema = extractionSchema(platform);
  const outputs = await Promise.all(
    images.map((image, index) =>
      llm.generate({
        stage: "vision",
        label: `extract-${index + 1}`,
        system: extractionSystemPrompt(platform),
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: image.mediaType, data: image.data },
          },
          {
            type: "text",
            text: `这是第 ${index + 1} 张截图，共 ${images.length} 张。平台：${def.label}。`,
          },
        ],
        schema,
        maxTokens: 16000,
      }),
    ),
  );

  const posts: Post[] = [];
  const coverHints: ExtractedRows["coverHints"] = {};
  const uncertain: ExtractedRows["uncertain"] = {};
  const notes: string[] = [];
  const seen = new Map<string, string>();
  let otherPages = 0;
  outputs.forEach(({ data }, imageIndex) => {
    if (data.pageKind === "other") otherPages += 1;
    for (const note of data.notes) notes.push(`第 ${imageIndex + 1} 张：${note}`);
    for (const row of data.rows) {
      const title = row.title.trim().slice(0, 500);
      const publishedAt = parsePublishedAt(row.publishedText, asOf);
      const key = `${title}::${publishedAt ?? row.publishedText ?? ""}`;
      if (!title || seen.has(key)) continue;
      const metrics: Record<string, number | null> = {};
      const unclear = new Set(row.uncertain);
      for (const metric of def.metrics) metrics[metric.key] = null;
      for (const cell of row.metrics) {
        const metricInfo = metricDef(platform, cell.metric);
        if (!metricInfo) continue;
        const value = parseMetricValue(cell.text, metricInfo.kind);
        metrics[cell.metric] = value;
        if (value === null) unclear.add(cell.metric);
      }
      if (row.publishedText && publishedAt === null) unclear.add("publishedText");
      const id = `p${posts.length + 1}`;
      seen.set(key, id);
      posts.push({ id, title, publishedAt, format: null, metrics, url: null });
      coverHints[id] = { coverFace: row.coverFace, coverBigText: row.coverBigText };
      if (unclear.size > 0) uncertain[id] = [...unclear];
    }
  });
  if (otherPages > 0) notes.push(`${otherPages} 张截图不是作品数据页，已跳过。`);
  return { posts, coverHints, uncertain, notes, usage: outputs.map((output) => output.usage) };
}

const labelBatchSize = 60;

/** Labels from titles, in batches. Cover attributes from screenshots are merged in, never invented. */
export async function labelPosts(
  llm: StructuredLlm,
  posts: Post[],
  coverHints: Record<string, Pick<PostLabels, "coverFace" | "coverBigText">> = {},
): Promise<{ labels: Record<string, PostLabels>; usage: UsageSummary[] }> {
  const labels: Record<string, PostLabels> = {};
  const usage: UsageSummary[] = [];
  for (let start = 0; start < posts.length; start += labelBatchSize) {
    const batch = posts.slice(start, start + labelBatchSize);
    const content = `<titles>\n${batch.map((post) => `<title id="${post.id}">${escapeXml(post.title)}</title>`).join("\n")}\n</titles>`;
    const result = await llm.generate({
      stage: "label",
      label: `label-${start / labelBatchSize + 1}`,
      system: labelSystemPrompt,
      content,
      schema: LabelOutputSchema,
      maxTokens: 16000,
    });
    usage.push(result.usage);
    const known = new Set(batch.map((post) => post.id));
    for (const row of result.data.labels) {
      if (!known.has(row.id)) continue;
      labels[row.id] = {
        hookType: row.hookType,
        topic: row.topic.trim().slice(0, 20) || null,
        isTutorial: row.isTutorial,
        emotional: row.emotional,
        personalStory: row.personalStory,
        coverFace: coverHints[row.id]?.coverFace ?? null,
        coverBigText: coverHints[row.id]?.coverBigText ?? null,
      };
    }
  }
  for (const post of posts) {
    labels[post.id] ??= { ...emptyLabels, ...coverHints[post.id] };
  }
  return { labels, usage };
}

function specKey(spec: HypothesisSpec): string {
  switch (spec.kind) {
    case "keywords":
      return `keywords:${[...spec.keywords].sort().join("|")}:${spec.direction}`;
    case "category":
      return `category:${spec.feature}=${spec.equals}:${spec.direction}`;
    default:
      return `${spec.kind}:${spec.feature}:${spec.direction}`;
  }
}

export interface ProposedHypotheses {
  hypotheses: Hypothesis[];
  rejected: number;
  usage: UsageSummary[];
}

/** AI proposals, validated against the features and metrics that actually exist. */
export async function proposeHypotheses(
  llm: StructuredLlm,
  input: {
    platform: PlatformId;
    posts: Post[];
    features: FeatureTable;
    metric: string;
    alreadyTested: Hypothesis[];
  },
): Promise<ProposedHypotheses> {
  const def = getPlatform(input.platform);
  const coverage = featureCoverage(input.features).filter((item) => item.present > 0);
  const metricsWithData = def.metrics.filter((metric) =>
    input.posts.some(
      (post) => post.metrics[metric.key] !== null && post.metrics[metric.key] !== undefined,
    ),
  );
  const content = [
    `<platform>${def.label}</platform>`,
    `<default_metric>${input.metric}</default_metric>`,
    `<metrics>${metricsWithData.map((metric) => `${metric.key}（${metric.label}）`).join("、")}</metrics>`,
    `<features>\n${coverage
      .map(
        (item) =>
          `- ${item.key}（${item.label}），kind=${item.kind}${item.values ? `，取值：${item.values.join("、")}` : ""}`,
      )
      .join("\n")}\n</features>`,
    `<already_tested>\n${input.alreadyTested.map((item) => `- ${item.claim}`).join("\n")}\n</already_tested>`,
    `<titles>\n${input.posts
      .slice(0, 300)
      .map((post) => `<title>${escapeXml(post.title)}</title>`)
      .join("\n")}\n</titles>`,
  ].join("\n");
  const result = await llm.generate({
    stage: "reason",
    label: "hypotheses",
    system: hypothesesSystemPrompt,
    content,
    schema: HypothesesOutputSchema,
    maxTokens: 8000,
  });

  const taken = new Set(input.alreadyTested.map((item) => specKey(item.spec)));
  const titlesLower = input.posts.map((post) => post.title.toLowerCase());
  const hypotheses: Hypothesis[] = [];
  let rejected = 0;
  for (const raw of result.data.hypotheses.slice(0, 10)) {
    const candidate =
      raw.kind === "keywords"
        ? {
            kind: raw.kind,
            keywords: (raw.keywords ?? []).map((word) => word.trim()).filter(Boolean),
            direction: raw.direction,
          }
        : raw.kind === "category"
          ? {
              kind: raw.kind,
              feature: raw.feature ?? "",
              equals: raw.equals ?? "",
              direction: raw.direction,
            }
          : { kind: raw.kind, feature: raw.feature ?? "", direction: raw.direction };
    const parsed = HypothesisSpecSchema.safeParse(candidate);
    if (!parsed.success) {
      rejected += 1;
      continue;
    }
    const spec = parsed.data;
    let valid = true;
    if (spec.kind === "keywords") {
      valid = spec.keywords.some((word) =>
        titlesLower.some((title) => title.includes(word.toLowerCase())),
      );
    } else {
      const feature = getFeature(spec.feature);
      const expectedKind = spec.kind === "feature" ? "binary" : spec.kind;
      valid = feature?.kind === expectedKind;
      if (valid && spec.kind === "category") {
        const values = coverage.find((item) => item.key === spec.feature)?.values ?? [];
        valid = values.includes(spec.equals);
      }
    }
    const metric = raw.metric && metricDef(input.platform, raw.metric) ? raw.metric : null;
    if (!valid || taken.has(specKey(spec))) {
      rejected += 1;
      continue;
    }
    taken.add(specKey(spec));
    const controllable =
      spec.kind === "keywords" ? true : (getFeature(spec.feature)?.controllable ?? false);
    hypotheses.push({
      id: `ai-${hypotheses.length + 1}`,
      origin: "ai",
      claim: raw.claim.trim().slice(0, 60),
      spec,
      metric,
      controllable,
      rationale: raw.rationale.trim().slice(0, 200),
    });
  }
  return { hypotheses, rejected, usage: [result.usage] };
}

/** Narration over the engine's own words; the caller checks every number it uses. */
export async function narrate(
  llm: StructuredLlm,
  input: {
    findings: Finding[];
    allowedNumbers: string[];
    templateSummary: string;
    feedback?: string;
  },
): Promise<{ data: NarrationOutput; usage: UsageSummary }> {
  const lines = input.findings.map(
    (finding) =>
      `<finding id="${finding.hypothesis.id}" verdict="${verdictLabels[finding.verdict]}">${escapeXml(finding.hypothesis.claim)}：${escapeXml(finding.evidence)}</finding>`,
  );
  const content = [
    `<findings>\n${lines.join("\n")}\n</findings>`,
    `<engine_summary>${escapeXml(input.templateSummary)}</engine_summary>`,
    `<allowed_numbers>${input.allowedNumbers.join(" ")}</allowed_numbers>`,
    input.feedback ? `<feedback>${escapeXml(input.feedback)}</feedback>` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const result = await llm.generate({
    stage: "reason",
    label: input.feedback ? "narrate-retry" : "narrate",
    system: narrationSystemPrompt,
    content,
    schema: NarrationOutputSchema,
    maxTokens: 4000,
  });
  return { data: result.data, usage: result.usage };
}

export { AiError };
