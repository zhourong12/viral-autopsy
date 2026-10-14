import { randomUUID } from "node:crypto";
import { getPlatform, metricDef, type PlatformId } from "../shared/platforms.js";
import type {
  AnalysisReport,
  ColumnAssignment,
  ExperimentRecord,
  ExperimentStatus,
  Hypothesis,
  ImportPreview,
  PortExperiment,
  PortRecord,
  PortRequest,
  PortSource,
  Post,
  PostLabels,
  UploadedFile,
  UsageSummary,
} from "../shared/schemas.js";
import { emptyLabels, portTargetLabels, portTargets } from "../shared/schemas.js";
import { AiError, type StructuredLlm } from "./ai/llm.js";
import {
  extractScreenshots,
  labelPosts,
  narrate,
  proposeHypotheses,
  type ScreenshotImage,
} from "./ai/steps.js";
import type { Db } from "./db/database.js";
import {
  AnalysisStore,
  DatasetStore,
  ExperimentStore,
  MappingStore,
  PortStore,
  UsageStore,
  type StoredDataset,
} from "./db/stores.js";
import { runEngine } from "./engine/analyze.js";
import { evaluateExperiment } from "./engine/experimentResult.js";
import { prescribeExperiments } from "./engine/experiments.js";
import { computeFeatures } from "./engine/features.js";
import { myths } from "./engine/myths.js";
import { buildStarter, starterExperiments } from "./engine/starter.js";
import { countVerdicts, starterSummary, templateSummary } from "./engine/summary.js";
import { buildAllowedNumbers, unverifiedNumbers } from "./guards/numberGuard.js";
import {
  headerCandidates,
  headerSignature,
  previewImport,
  tableToPosts,
} from "./import/mapping.js";
import { postsFromSinglePostExports } from "./import/singlePost.js";
import { allowedNumbersFor, buildDraft, titleFitsArm } from "./porting/checks.js";
import { rewriteForPlatforms, transcribePosts } from "./porting/steps.js";
import { ImportError, parseDelimitedText, parseImportFile, type Table } from "./import/table.js";
import { generateAccount } from "./synth/synth.js";

export type Plan = "free" | "pro";

export const planLimits: Record<
  Plan,
  { aiAnalysesPerMonth: number | null; portsPerMonth: number | null }
> = {
  free: { aiAnalysesPerMonth: 1, portsPerMonth: 5 },
  pro: { aiAnalysesPerMonth: null, portsPerMonth: null },
};

export class ServiceError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "not_confirmed"
      | "no_metric"
      | "plan_limit"
      | "ai_not_configured"
      | "invalid_posts"
      | "experiment_mismatch",
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
  readonly mappings: MappingStore;
  readonly experiments: ExperimentStore;
  readonly ports: PortStore;
  private readonly today: () => string;

  constructor(private readonly options: ServiceOptions) {
    this.datasets = new DatasetStore(options.db);
    this.analyses = new AnalysisStore(options.db);
    this.usage = new UsageStore(options.db);
    this.mappings = new MappingStore(options.db);
    this.experiments = new ExperimentStore(
      options.db,
      (platform, metric) => metricDef(platform as PlatformId, metric)?.label ?? metric,
    );
    this.ports = new PortStore(options.db);
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

  /** A mapping the user saved earlier for the same header layout, if any. */
  private savedAssignment(table: Table, platform: PlatformId): ColumnAssignment | null {
    for (const candidate of headerCandidates(table)) {
      const saved = this.mappings.get(platform, candidate.signature);
      if (saved && saved.headerRow === candidate.row) return saved;
    }
    return null;
  }

  private rememberAssignment(table: Table, platform: PlatformId, assignment: ColumnAssignment) {
    const headers = (table[assignment.headerRow] ?? []).map((cell) =>
      cell === null || cell === undefined ? "" : String(cell).trim(),
    );
    this.mappings.save(platform, headerSignature(headers), assignment);
  }

  /**
   * Files become posts directly when each is one post's own export, otherwise a lone file's
   * first sheet is a table for column mapping. Pasted text is always a table.
   */
  private async loadSource(
    input: { kind: "file"; files: UploadedFile[] } | { kind: "paste"; text: string },
    platform: PlatformId,
  ): Promise<{ kind: "posts"; posts: Post[]; notes: string[] } | { kind: "table"; table: Table }> {
    if (input.kind === "paste") return { kind: "table", table: parseDelimitedText(input.text) };
    const files = await Promise.all(
      input.files.map(async (file) => ({
        fileName: file.fileName,
        sheets: await parseImportFile(file.fileName, file.content, file.encoding),
      })),
    );
    const posts = postsFromSinglePostExports(files, platform, this.today());
    if (posts) return { kind: "posts", ...posts };
    const table = files[0]?.sheets[0]?.table;
    if (!table) throw new ImportError("empty_file", "文件里没有数据行。");
    return { kind: "table", table };
  }

  /** How the input would be read, so the user can fix column assignments before importing. */
  async previewImport(
    input: ({ kind: "file"; files: UploadedFile[] } | { kind: "paste"; text: string }) & {
      platform: PlatformId;
      assignment?: ColumnAssignment;
    },
  ): Promise<ImportPreview> {
    const source = await this.loadSource(input, input.platform);
    if (source.kind === "posts") return source;
    const saved = input.assignment ? null : this.savedAssignment(source.table, input.platform);
    return previewImport(
      source.table,
      input.platform,
      this.today(),
      input.assignment ?? saved ?? undefined,
      saved !== null,
    );
  }

  private createFromTable(
    table: Table,
    input: {
      platform: PlatformId;
      accountName: string;
      assignment?: ColumnAssignment;
      source: "file" | "paste";
    },
  ): StoredDataset {
    const asOf = this.today();
    const assignment = input.assignment ?? this.savedAssignment(table, input.platform) ?? undefined;
    const result = tableToPosts(table, input.platform, asOf, assignment);
    if (input.assignment) this.rememberAssignment(table, input.platform, input.assignment);
    return this.datasets.create({
      platform: input.platform,
      accountName: input.accountName,
      source: input.source,
      isSample: false,
      confirmed: false,
      posts: result.posts,
      importNotes: result.notes,
      asOf,
    });
  }

  async importFile(input: {
    platform: PlatformId;
    accountName: string;
    files: UploadedFile[];
    assignment?: ColumnAssignment;
  }): Promise<StoredDataset> {
    const source = await this.loadSource({ kind: "file", files: input.files }, input.platform);
    if (source.kind === "table") {
      return this.createFromTable(source.table, { ...input, source: "file" });
    }
    return this.datasets.create({
      platform: input.platform,
      accountName: input.accountName,
      source: "file",
      isSample: false,
      confirmed: false,
      posts: source.posts,
      importNotes: source.notes,
      asOf: this.today(),
    });
  }

  importPaste(input: {
    platform: PlatformId;
    accountName: string;
    text: string;
    assignment?: ColumnAssignment;
  }): StoredDataset {
    return this.createFromTable(parseDelimitedText(input.text), { ...input, source: "paste" });
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
    const starter = buildStarter(
      dataset.platform,
      dataset.posts,
      metric,
      dataset.asOf,
      engine.postsUsed,
    );
    const signals = prescribeExperiments(engine.findings, dataset.platform);
    const experiments = starter
      ? [
          ...signals,
          ...starterExperiments({
            platform: dataset.platform,
            posts: dataset.posts,
            metric,
            asOf: dataset.asOf,
            hypotheses,
            existing: signals,
          }),
        ]
      : signals;
    const fallbackSummary = starter
      ? starterSummary(starter, experiments, dataset.posts.length, dataset.platform, metric)
      : templateSummary(engine.findings, experiments, engine.postsUsed, dataset.platform);
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
    const relevant = engine.findings.filter((finding) => finding.verdict !== "insufficient");
    // With nothing beyond "insufficient" there is nothing for the AI to explain.
    if (useAi && this.options.llm && relevant.length > 0) {
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
      starter,
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

  /** Turn a prescription from a report into a running experiment. Starting twice returns the first. */
  startExperiment(input: {
    reportId: string;
    hypothesisId: string;
    startedOn?: string;
  }): ExperimentRecord {
    const report = this.analyses.get(input.reportId);
    if (!report) throw new ServiceError("not_found", "找不到这份报告。");
    const plan = report.experiments.find((item) => item.hypothesisId === input.hypothesisId);
    const finding = report.findings.find((item) => item.hypothesis.id === input.hypothesisId);
    // Starter plans carry their hypothesis: a new account's claims often have no finding.
    const hypothesis = plan?.hypothesis ?? finding?.hypothesis;
    if (!plan || !hypothesis) throw new ServiceError("not_found", "这份报告里没有这个实验处方。");
    const existing = this.experiments.findRunning(
      report.accountName,
      report.platform,
      hypothesis.claim,
    );
    if (existing) return existing;
    return this.experiments.create({
      platform: report.platform,
      accountName: report.accountName,
      sourceReportId: report.id,
      hypothesis,
      plan,
      metric: finding?.metric ?? hypothesis.metric ?? report.metric,
      startedOn: input.startedOn ?? this.today(),
      status: "running",
    });
  }

  requireExperiment(id: string): ExperimentRecord {
    const experiment = this.experiments.get(id);
    if (!experiment) throw new ServiceError("not_found", "找不到这个实验。");
    return experiment;
  }

  /** Check a running experiment against freshly imported (and confirmed) data. */
  checkExperiment(id: string, datasetId: string): ExperimentRecord {
    const experiment = this.requireExperiment(id);
    const dataset = this.requireDataset(datasetId);
    if (dataset.platform !== experiment.platform) {
      throw new ServiceError("experiment_mismatch", "这份数据和实验不是同一个平台。");
    }
    if (!dataset.confirmed) {
      throw new ServiceError("not_confirmed", "请先在表格里核对并确认数据，再核对实验。");
    }
    const result = evaluateExperiment({
      platform: dataset.platform,
      posts: dataset.posts,
      labels: dataset.labels,
      asOf: dataset.asOf,
      datasetId: dataset.id,
      hypothesis: experiment.hypothesis,
      plan: experiment.plan,
      metric: experiment.metric,
      startedOn: experiment.startedOn,
      iterations: this.options.iterations,
    });
    const decided = result.outcome === "supported" || result.outcome === "not_supported";
    this.experiments.saveResult(id, result, decided ? "finished" : experiment.status);
    return this.requireExperiment(id);
  }

  setExperimentStatus(id: string, status: ExperimentStatus): ExperimentRecord {
    this.requireExperiment(id);
    this.experiments.setStatus(id, status);
    return this.requireExperiment(id);
  }

  // -------------------------------------------------------------------------
  // 搬运台

  portsLeft(): number | null {
    const limit = planLimits[this.options.plan].portsPerMonth;
    if (limit === null) return null;
    return Math.max(0, limit - this.ports.countThisMonth(new Date().toISOString().slice(0, 7)));
  }

  /** Screenshots of X posts to text the user can correct. Nothing is stored. */
  async transcribeForPort(
    images: ScreenshotImage[],
  ): Promise<{ text: string; author: string | null; notes: string[]; uncertain: string[] }> {
    const transcript = await transcribePosts(this.requireLlm(), images);
    this.recordUsage(null, "port-transcribe", transcript.usage);
    return {
      text: transcript.text,
      author: transcript.author,
      notes: transcript.notes,
      uncertain: transcript.uncertain,
    };
  }

  /** The running experiment a rewrite should follow, checked against the chosen platforms. */
  private portExperiment(input: PortRequest): {
    record: PortExperiment;
    hypothesis: Hypothesis;
    titleRule: string | null;
  } | null {
    if (!input.experiment) return null;
    const experiment = this.requireExperiment(input.experiment.id);
    if (experiment.status !== "running") {
      throw new ServiceError("experiment_mismatch", "这个实验已经结束或放弃了。");
    }
    const platform = portTargets.find((target) => target === experiment.platform);
    if (!platform) {
      throw new ServiceError(
        "experiment_mismatch",
        "搬运台只写小红书、公众号和抖音，这个实验不是这三个平台的。",
      );
    }
    if (!input.targets.includes(platform)) {
      throw new ServiceError(
        "experiment_mismatch",
        `这个实验是${getPlatform(platform).label}的，请在目标平台里选上它。`,
      );
    }
    const { arm } = input.experiment;
    const variant = arm === "A" ? experiment.plan.variantA : experiment.plan.variantB;
    const checkable = titleFitsArm(experiment.hypothesis, arm, "示例标题") !== null;
    return {
      record: { id: experiment.id, claim: experiment.hypothesis.claim, arm, variant, platform },
      hypothesis: experiment.hypothesis,
      titleRule: checkable
        ? `只对 ${platform} 的标题：这篇属于实验 ${arm} 组，三个标题都必须做到“${variant}”。`
        : null,
    };
  }

  async createPort(input: PortRequest): Promise<PortRecord> {
    const llm = this.requireLlm();
    if (this.portsLeft() === 0) {
      throw new ServiceError(
        "plan_limit",
        `免费版每月可以搬运 ${planLimits[this.options.plan].portsPerMonth} 次，本月已用完。`,
      );
    }
    const experiment = this.portExperiment(input);
    const source: PortSource = {
      text: input.source.text,
      author: input.source.author || null,
      url: input.source.url || null,
    };
    const allowed = allowedNumbersFor(source, input.myTake);
    const { output, usage, retried } = await rewriteForPlatforms(llm, {
      source,
      myTake: input.myTake,
      targets: input.targets,
      titleRule: experiment?.titleRule ?? null,
      allowed,
    });

    const drafts = input.targets.flatMap((target) => {
      const raw = output.drafts.find((draft) => draft.platform === target);
      return raw
        ? [
            buildDraft(raw, {
              source,
              allowed,
              experiment: experiment
                ? {
                    hypothesis: experiment.hypothesis,
                    arm: experiment.record.arm,
                    variant: experiment.record.variant,
                    platform: experiment.record.platform,
                  }
                : null,
            }),
          ]
        : [];
    });
    const warnings: string[] = [];
    const missing = input.targets.filter((target) => !drafts.some((d) => d.platform === target));
    if (missing.length > 0) {
      warnings.push(
        `AI 没有写出${missing.map((target) => portTargetLabels[target]).join("、")}，可以再生成一次。`,
      );
    }
    if (!input.myTake.trim()) {
      warnings.push(
        "没有写你自己的观点：这篇基本是翻译改写，发布时不要勾选原创声明。加上你的实测或看法，内容更站得住，也更不像搬运。",
      );
    }
    if (retried) {
      warnings.push("第一版用了原文里没有的数字，已让 AI 重写一次；还剩下的会在各平台下面标出来。");
    }

    const record = this.ports.create({
      source,
      myTake: input.myTake,
      experiment: experiment?.record ?? null,
      summary: output.summary.trim(),
      checks: output.checks.filter((item) => item.claim.trim()),
      context: output.context.map((item) => item.trim()).filter(Boolean),
      drafts,
      warnings,
      usage,
    });
    this.recordUsage(record.id, "port", usage);
    return record;
  }

  requirePort(id: string): PortRecord {
    const record = this.ports.get(id);
    if (!record) throw new ServiceError("not_found", "找不到这条搬运记录。");
    return record;
  }
}

export { AiError };
