import { randomUUID } from "node:crypto";
import type { PlatformId } from "../../shared/platforms.js";
import type {
  AnalysisReport,
  ColumnAssignment,
  Dataset,
  DatasetSource,
  ExperimentRecord,
  ExperimentResult,
  ExperimentStatus,
  Post,
  PostLabels,
  UsageSummary,
} from "../../shared/schemas.js";
import type { Db } from "./database.js";

export interface StoredDataset extends Dataset {
  confirmed: boolean;
  coverHints: Record<string, Pick<PostLabels, "coverFace" | "coverBigText">>;
  uncertain: Record<string, string[]>;
  updatedAt: string;
}

interface DatasetRow {
  id: string;
  platform: string;
  account_name: string;
  source: string;
  is_sample: number;
  confirmed: number;
  posts_json: string;
  labels_json: string;
  label_source: string;
  cover_hints_json: string;
  uncertain_json: string;
  import_notes_json: string;
  as_of: string;
  created_at: string;
  updated_at: string;
}

function toDataset(row: DatasetRow): StoredDataset {
  return {
    id: row.id,
    platform: row.platform as PlatformId,
    accountName: row.account_name,
    source: row.source as DatasetSource,
    isSample: row.is_sample === 1,
    confirmed: row.confirmed === 1,
    posts: JSON.parse(row.posts_json) as Post[],
    labels: JSON.parse(row.labels_json) as Record<string, PostLabels>,
    labelSource: row.label_source as Dataset["labelSource"],
    coverHints: JSON.parse(row.cover_hints_json) as StoredDataset["coverHints"],
    uncertain: JSON.parse(row.uncertain_json) as Record<string, string[]>,
    importNotes: JSON.parse(row.import_notes_json) as string[],
    asOf: row.as_of,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewDataset {
  platform: PlatformId;
  accountName: string;
  source: DatasetSource;
  isSample: boolean;
  confirmed: boolean;
  posts: Post[];
  labels?: Record<string, PostLabels>;
  labelSource?: Dataset["labelSource"];
  coverHints?: StoredDataset["coverHints"];
  uncertain?: Record<string, string[]>;
  importNotes: string[];
  asOf: string;
}

export class DatasetStore {
  constructor(private readonly db: Db) {}

  create(input: NewDataset): StoredDataset {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO datasets (id, platform, account_name, source, is_sample, confirmed, posts_json, labels_json,
          label_source, cover_hints_json, uncertain_json, import_notes_json, as_of, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.platform,
        input.accountName,
        input.source,
        input.isSample ? 1 : 0,
        input.confirmed ? 1 : 0,
        JSON.stringify(input.posts),
        JSON.stringify(input.labels ?? {}),
        input.labelSource ?? "none",
        JSON.stringify(input.coverHints ?? {}),
        JSON.stringify(input.uncertain ?? {}),
        JSON.stringify(input.importNotes),
        input.asOf,
        now,
        now,
      );
    return this.get(id) as StoredDataset;
  }

  get(id: string): StoredDataset | null {
    const row = this.db.prepare("SELECT * FROM datasets WHERE id = ?").get(id) as
      DatasetRow | undefined;
    return row ? toDataset(row) : null;
  }

  list(): Array<
    Pick<
      StoredDataset,
      "id" | "platform" | "accountName" | "source" | "isSample" | "confirmed" | "createdAt"
    > & { postCount: number }
  > {
    const rows = this.db
      .prepare("SELECT * FROM datasets ORDER BY created_at DESC LIMIT 200")
      .all() as unknown as DatasetRow[];
    return rows.map((row) => {
      const dataset = toDataset(row);
      return {
        id: dataset.id,
        platform: dataset.platform,
        accountName: dataset.accountName,
        source: dataset.source,
        isSample: dataset.isSample,
        confirmed: dataset.confirmed,
        createdAt: dataset.createdAt,
        postCount: dataset.posts.length,
      };
    });
  }

  updatePosts(id: string, posts: Post[]): void {
    this.db
      .prepare(
        "UPDATE datasets SET posts_json = ?, confirmed = 1, uncertain_json = '{}', updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(posts), new Date().toISOString(), id);
  }

  updateLabels(
    id: string,
    labels: Record<string, PostLabels>,
    source: Dataset["labelSource"],
  ): void {
    this.db
      .prepare("UPDATE datasets SET labels_json = ?, label_source = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(labels), source, new Date().toISOString(), id);
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM datasets WHERE id = ?").run(id).changes > 0;
  }
}

export class AnalysisStore {
  constructor(private readonly db: Db) {}

  save(report: AnalysisReport): void {
    this.db
      .prepare(
        "INSERT INTO analyses (id, dataset_id, mode, is_sample, report_json, month, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        report.id,
        report.datasetId,
        report.mode,
        report.isSample ? 1 : 0,
        JSON.stringify(report),
        report.createdAt.slice(0, 7),
        report.createdAt,
      );
  }

  get(id: string): AnalysisReport | null {
    const row = this.db.prepare("SELECT report_json FROM analyses WHERE id = ?").get(id) as
      { report_json: string } | undefined;
    return row ? (JSON.parse(row.report_json) as AnalysisReport) : null;
  }

  list(): Array<
    Pick<
      AnalysisReport,
      | "id"
      | "datasetId"
      | "platform"
      | "accountName"
      | "isSample"
      | "mode"
      | "metricLabel"
      | "createdAt"
      | "postsUsed"
    >
  > {
    const rows = this.db
      .prepare("SELECT report_json FROM analyses ORDER BY created_at DESC LIMIT 100")
      .all() as Array<{ report_json: string }>;
    return rows.map((row) => {
      const report = JSON.parse(row.report_json) as AnalysisReport;
      return {
        id: report.id,
        datasetId: report.datasetId,
        platform: report.platform,
        accountName: report.accountName,
        isSample: report.isSample,
        mode: report.mode,
        metricLabel: report.metricLabel,
        createdAt: report.createdAt,
        postsUsed: report.postsUsed,
      };
    });
  }

  countAiThisMonth(month: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM analyses WHERE month = ? AND mode = 'ai' AND is_sample = 0",
      )
      .get(month) as { count: number };
    return row.count;
  }
}

export class UsageStore {
  constructor(private readonly db: Db) {}

  record(referenceId: string | null, label: string, usage: UsageSummary): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO usage_events (reference_id, label, model, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, cost_usd, month, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        referenceId,
        label,
        usage.model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
        usage.costUsd,
        now.slice(0, 7),
        now,
      );
  }

  monthTotals(month: string): {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  } {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(cost_usd), 0) AS cost FROM usage_events WHERE month = ?",
      )
      .get(month) as { calls: number; input: number; output: number; cost: number };
    return {
      calls: row.calls,
      inputTokens: row.input,
      outputTokens: row.output,
      costUsd: Math.round(row.cost * 10000) / 10000,
    };
  }
}

/** Column mappings the user confirmed, keyed by platform and header layout. */
export class MappingStore {
  constructor(private readonly db: Db) {}

  get(platform: PlatformId, signature: string): ColumnAssignment | null {
    const row = this.db
      .prepare("SELECT assignment_json FROM column_mappings WHERE platform = ? AND signature = ?")
      .get(platform, signature) as { assignment_json: string } | undefined;
    return row ? (JSON.parse(row.assignment_json) as ColumnAssignment) : null;
  }

  save(platform: PlatformId, signature: string, assignment: ColumnAssignment): void {
    this.db
      .prepare(
        `INSERT INTO column_mappings (platform, signature, assignment_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (platform, signature) DO UPDATE SET assignment_json = excluded.assignment_json, updated_at = excluded.updated_at`,
      )
      .run(platform, signature, JSON.stringify(assignment), new Date().toISOString());
  }
}

interface ExperimentRow {
  id: string;
  platform: string;
  account_name: string;
  source_report_id: string | null;
  hypothesis_json: string;
  plan_json: string;
  metric: string;
  started_on: string;
  status: string;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

function toExperiment(
  row: ExperimentRow,
  metricLabel: (platform: string, metric: string) => string,
): ExperimentRecord {
  return {
    id: row.id,
    platform: row.platform as PlatformId,
    accountName: row.account_name,
    sourceReportId: row.source_report_id,
    hypothesis: JSON.parse(row.hypothesis_json) as ExperimentRecord["hypothesis"],
    plan: JSON.parse(row.plan_json) as ExperimentRecord["plan"],
    metric: row.metric,
    metricLabel: metricLabel(row.platform, row.metric),
    startedOn: row.started_on,
    status: row.status as ExperimentStatus,
    result: row.result_json ? (JSON.parse(row.result_json) as ExperimentResult) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ExperimentStore {
  constructor(
    private readonly db: Db,
    private readonly metricLabel: (platform: string, metric: string) => string,
  ) {}

  create(
    input: Omit<ExperimentRecord, "id" | "result" | "createdAt" | "updatedAt" | "metricLabel">,
  ): ExperimentRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO experiments (id, platform, account_name, source_report_id, hypothesis_json, plan_json, metric,
          started_on, status, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        input.platform,
        input.accountName,
        input.sourceReportId,
        JSON.stringify(input.hypothesis),
        JSON.stringify(input.plan),
        input.metric,
        input.startedOn,
        input.status,
        now,
        now,
      );
    return this.get(id) as ExperimentRecord;
  }

  get(id: string): ExperimentRecord | null {
    const row = this.db.prepare("SELECT * FROM experiments WHERE id = ?").get(id) as
      ExperimentRow | undefined;
    return row ? toExperiment(row, this.metricLabel) : null;
  }

  list(): ExperimentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM experiments ORDER BY created_at DESC LIMIT 200")
      .all() as unknown as ExperimentRow[];
    return rows.map((row) => toExperiment(row, this.metricLabel));
  }

  findRunning(
    accountName: string,
    platform: PlatformId,
    hypothesisClaim: string,
  ): ExperimentRecord | null {
    return (
      this.list().find(
        (item) =>
          item.status === "running" &&
          item.accountName === accountName &&
          item.platform === platform &&
          item.hypothesis.claim === hypothesisClaim,
      ) ?? null
    );
  }

  saveResult(id: string, result: ExperimentResult, status: ExperimentStatus): void {
    this.db
      .prepare("UPDATE experiments SET result_json = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(result), status, new Date().toISOString(), id);
  }

  setStatus(id: string, status: ExperimentStatus): void {
    this.db
      .prepare("UPDATE experiments SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  }
}
