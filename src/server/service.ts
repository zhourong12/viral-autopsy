import { randomUUID } from "node:crypto";
import { getPlatform, metricDef, type PlatformId } from "../shared/platforms.js";
import type { AnalysisReport, Post, PostLabels, UsageSummary } from "../shared/schemas.js";
import { emptyLabels } from "../shared/schemas.js";
import { AiError, type StructuredLlm } from "./ai/llm.js";
import {
  extractScreenshots,
  labelPosts,
  narrate,
  proposeHypotheses,
  type ScreenshotImage,
} from "./ai/steps.js";
import type { Db } from "./db/database.js";
import { AnalysisStore, DatasetStore, UsageStore, type StoredDataset } from "./db/stores.js";
import { runEngine } from "./engine/analyze.js";
import { prescribeExperiments } from "./engine/experiments.js";
import { computeFeatures } from "./engine/features.js";
import { myths } from "./engine/myths.js";
import { countVerdicts, templateSummary } from "./engine/summary.js";
import { buildAllowedNumbers, unverifiedNumbers } from "./guards/numberGuard.js";
import { tableToPosts } from "./import/mapping.js";
import { parseDelimitedText, parseImportFile } from "./import/table.js";
import { generateAccount } from "./synth/synth.js";

export type Plan = "free" | "pro";

export const planLimits: Record<Plan, { aiAnalysesPerMonth: number | null }> = {
  free: { aiAnalysesPerMonth: 1 },
  pro: { aiAnalysesPerMonth: null },
};

export class ServiceError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "not_confirmed"
      | "no_metric"
      | "plan_limit"
      | "ai_not_configured"
      | "invalid_posts",
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface ServiceOptions {
  db: Db;
  plan: Plan;
  /** Null when no API key is configured: everything except screenshots and labels still works. */
  llm: StructuredLlm | null;
  /** Injectable clock for tests: returns YYYY-MM-DD. */
  today?: () => string;
  iterations?: number;
}

function localToday(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export class AutopsyService {
  readonly datasets: DatasetStore;
  readonly analyses: AnalysisStore;
  readonly usage: UsageStore;
  private readonly today: () => string;

  constructor(private readonly options: ServiceOptions) {
    this.datasets = new DatasetStore(options.db);
    this.analyses = new AnalysisStore(options.db);
    this.usage = new UsageStore(options.db);
    this.today = options.today ?? localToday;
  }

  get aiConfigured(): boolean {
    return this.options.llm !== null;
  }

  private requireLlm(): StructuredLlm {
    if (!this.options.llm) {
      throw new ServiceError(
        "ai_not_configured",
        "没有配置 Claude API Key：截图识别和 AI 标注不可用，表格导入和规则检验照常可用。",
      );
    }
    return this.options.llm;
  }

  private recordUsage(referenceId: string | null, label: string, usage: UsageSummary[]): void {
    for (const item of usage) this.usage.record(referenceId, label, item);
  }

  requireDataset(id: string): StoredDataset {
    const dataset = this.datasets.get(id);
    if (!dataset) throw new ServiceError("not_found", "找不到这份数据，可能已被删除。");
    return dataset;
  }

  async importFile(input: {
    platform: PlatformId;
    accountName: string;
    fileName: string;
    content: string;
    encoding: "text" | "base64";
  }): Promise<StoredDataset> {
    const table = await parseImportFile(input.fileName, input.content, input.encoding);
    const asOf = this.today();
    const result = tableToPosts(table, input.platform, asOf);
    return this.datasets.create({
      platform: input.platform,
      accountName: input.accountName,
      source: "file",
      isSample: false,
      confirmed: false,
      posts: result.posts,
      importNotes: result.notes,
      asOf,
    });
  }

  importPaste(input: { platform: PlatformId; accountName: string; text: string }): StoredDataset {
    const asOf = this.today();
    const result = tableToPosts(parseDelimitedText(input.text), input.platform, asOf);
    return this.datasets.create({
      platform: input.platform,
      accountName: input.accountName,
      source: "paste",
      isSample: false,
      confirmed: false,
      posts: result.posts,
      importNotes: result.notes,
      asOf,
    });
  }

  /** Screenshots are used once and never stored; only the transcribed rows are kept. */
  async importScreenshots(input: {
    platform: PlatformId;
    accountName: string;
    images: ScreenshotImage[];
  }): Promise<StoredDataset> {
    const llm = this.requireLlm();
    const asOf = this.today();
    const extracted = await extractScreenshots(llm, input.platform, input.images, asOf);
    const dataset = this.datasets.create({
      platform: input.platform,
      accountName: input.accountName,
      source: "screenshot",
      isSample: false,
      confirmed: false,
      posts: extracted.posts,
      coverHints: extracted.coverHints,
      uncertain: extracted.uncertain,
      importNotes: [
        `从 ${input.images.length} 张截图里识别出 ${extracted.posts.length} 条，请逐格核对后确认。`,
        ...extracted.notes,
      ],
      asOf,
    });
    this.recordUsage(dataset.id, "extract", extracted.usage);
    return dataset;
  }

  createSample(platform: PlatformId): StoredDataset {
    const account = generateAccount({ platform, seed: Math.floor(Math.random() * 1_000_000) });
    return this.datasets.create({
      platform,
      accountName: `合成示例账号（${getPlatform(platform).label}）`,
      source: "sample",
      isSample: true,
      confirmed: true,
      posts: account.posts,
      labels: account.labels,
      labelSource: "user",
      importNotes: [
        "这是合成示例数据，不是真实账号。数据里预埋了两条真规律（问句标题、教程类收藏）和两个陷阱（露脸封面、单篇爆文），可以用来体验解剖结果。",
      ],
      asOf: account.asOf,
    });
  }

  confirmPosts(id: string, posts: Post[]): StoredDataset {
    const dataset = this.requireDataset(id);
    const ids = new Set<string>();
    for (const post of posts) {
      if (ids.has(post.id)) throw new ServiceError("invalid_posts", `编号 ${post.id} 重复。`);
      ids.add(post.id);
    }
    this.datasets.updatePosts(id, posts);
    // Labels of removed posts go away with them.
    const labels = Object.fromEntries(
      Object.entries(dataset.labels).filter(([postId]) => ids.has(postId)),
    );
    this.datasets.updateLabels(id, labels, dataset.labelSource);
    return this.requireDataset(id);
  }

  async labelDataset(id: string): Promise<StoredDataset> {
    const llm = this.requireLlm();
    const dataset = this.requireDataset(id);
    const result = await labelPosts(llm, dataset.posts, dataset.coverHints);
    this.recordUsage(id, "label", result.usage);
    this.datasets.updateLabels(id, result.labels, "ai");
    return this.requireDataset(id);
  }

  updateLabels(id: string, labels: Record<string, PostLabels>): StoredDataset {
    const dataset = this.requireDataset(id);
    const merged: Record<string, PostLabels> = {};
    for (const post of dataset.posts)
      merged[post.id] = labels[post.id] ?? dataset.labels[post.id] ?? { ...emptyLabels };
    this.datasets.updateLabels(id, merged, "user");
    return this.requireDataset(id);
  }

  aiAnalysesLeft(): number | null {
    const limit = planLimits[this.options.plan].aiAnalysesPerMonth;
    if (limit === null) return null;
    return Math.max(
      0,
      limit - this.analyses.countAiThisMonth(new Date().toISOString().slice(0, 7)),
    );
  }

  async analyze(input: {
    datasetId: string;
    metric?: string;
    useAi: boolean;
  }): Promise<AnalysisReport> {
    let dataset = this.requireDataset(input.datasetId);
    if (!dataset.confirmed) {
      throw new ServiceError("not_confirmed", "请先在表格里核对并确认数据，再开始解剖。");
    }
    const platform = getPlatform(dataset.platform);
    const metric = input.metric ?? platform.defaultMetric;
    const metricInfo = metricDef(dataset.platform, metric);
    if (
      !metricInfo ||
      !dataset.posts.some(
        (post) => post.metrics[metric] !== null && post.metrics[metric] !== undefined,
      )
    ) {
      throw new ServiceError(
        "no_metric",
        `数据里没有“${metricInfo?.label ?? metric}”，请换一个指标。`,
      );
    }

    const useAi = input.useAi && this.options.llm !== null;
    if (useAi && !dataset.isSample && this.aiAnalysesLeft() === 0) {
      throw new ServiceError(
        "plan_limit",
        "免费版每月可以做 1 次 AI 解剖，本月已用完。规则检验不受限制。",
      );
    }
    const reportId = randomUUID();
    const usage: UsageSummary[] = [];
    const warnings: string[] = [];

    if (useAi && dataset.labelSource === "none") {
      dataset = await this.labelDataset(dataset.id);
      warnings.push("内容标签由 AI 自动标注，可以在“标签”里修改后重新解剖。");
    }

    const hypotheses = [...myths];
    if (useAi && this.options.llm) {
      const features = computeFeatures(dataset.posts, dataset.labels);
      const proposed = await proposeHypotheses(this.options.llm, {
        platform: dataset.platform,
        posts: dataset.posts,
        features,
        metric,
        alreadyTested: myths,
      });
      usage.push(...proposed.usage);
      hypotheses.push(...proposed.hypotheses);
      if (proposed.rejected > 0)
        warnings.push(
          `AI 提出的 ${proposed.rejected} 条猜想无法检验（特征不存在或重复），已舍弃。`,
        );
    }

    const engine = runEngine({
      platform: dataset.platform,
      posts: dataset.posts,
      labels: dataset.labels,
      metric,
      hypotheses,
      asOf: dataset.asOf,
      iterations: this.options.iterations,
    });
    const experiments = prescribeExperiments(engine.findings, dataset.platform);
    const fallbackSummary = templateSummary(
      engine.findings,
      experiments,
      engine.postsUsed,
      dataset.platform,
    );
    const counts = countVerdicts(engine.findings);
    const allowed = buildAllowedNumbers(
      [
        fallbackSummary,
        ...engine.findings.map((finding) => finding.evidence),
        ...engine.findings.flatMap((finding) => finding.checks.map((check) => check.detail)),
        ...experiments.flatMap((plan) => plan.instructions),
        ...engine.exclusionNotes,
      ],
      [
        engine.postsUsed,
        engine.postsExcluded,
        engine.findings.length,
        counts.established,
        counts.questionable,
        counts.insufficient,
        counts.buried,
        platform.maturityDays,
      ],
    );

    let summary = fallbackSummary;
    let summarySource: AnalysisReport["summarySource"] = "template";
    let flagged: string[] = [];
    let alternatives: AnalysisReport["alternatives"] = [];
    if (useAi && this.options.llm) {
      const relevant = engine.findings.filter((finding) => finding.verdict !== "insufficient");
      let narration = await narrate(this.options.llm, {
        findings: relevant,
        allowedNumbers: [...allowed],
        templateSummary: fallbackSummary,
      });
      usage.push(narration.usage);
      flagged = unverifiedNumbers(narration.data.summary, allowed);
      if (flagged.length > 0) {
        narration = await narrate(this.options.llm, {
          findings: relevant,
          allowedNumbers: [...allowed],
          templateSummary: fallbackSummary,
          feedback: `上一版总结用了引擎结果里没有的数字：${flagged.join("、")}。请只用 allowed_numbers 里的数字重写。`,
        });
        usage.push(narration.usage);
        flagged = unverifiedNumbers(narration.data.summary, allowed);
      }
      if (flagged.length === 0 && narration.data.summary.trim()) {
        summary = narration.data.summary.trim();
        summarySource = "ai";
      } else if (flagged.length > 0) {
        warnings.push("AI 写的总结用了核对不上的数字，已改用引擎自动生成的总结。");
      }
      const eligible = new Set(
        engine.findings
          .filter(
            (finding) => finding.verdict === "established" || finding.verdict === "questionable",
          )
          .map((finding) => finding.hypothesis.id),
      );
      alternatives = narration.data.alternatives
        .filter(
          (item) =>
            eligible.has(item.hypothesisId) && unverifiedNumbers(item.text, allowed).length === 0,
        )
        .map((item) => ({ hypothesisId: item.hypothesisId, text: item.text.trim().slice(0, 200) }));
    }

    const report: AnalysisReport = {
      id: reportId,
      datasetId: dataset.id,
      platform: dataset.platform,
      accountName: dataset.accountName,
      isSample: dataset.isSample,
      mode: useAi ? "ai" : "rules_only",
      metric,
      metricLabel: metricInfo.label,
      createdAt: new Date().toISOString(),
      postsUsed: engine.postsUsed,
      postsExcluded: engine.postsExcluded,
      exclusionNotes: engine.exclusionNotes,
      findings: engine.findings,
      untested: engine.untested,
      experiments,
      summary,
      summarySource,
      unverifiedNumbers: summarySource === "ai" ? [] : flagged,
      alternatives,
      usage,
      warnings: [
        ...(input.useAi && !this.options.llm
          ? ["没有配置 Claude API Key，这次只做了规则检验（未使用 AI）。"]
          : []),
        ...engine.warnings,
        ...warnings,
      ],
    };
    this.analyses.save(report);
    this.recordUsage(reportId, "analysis", usage);
    return report;
  }
}

export { AiError };
