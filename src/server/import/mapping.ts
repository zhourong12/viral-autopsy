import { columnAliases, getPlatform, type PlatformId } from "../../shared/platforms.js";
import type { ColumnAssignment, Post, TableImportPreview } from "../../shared/schemas.js";
import { ImportError, maxRows, type Cell, type Table } from "./table.js";
import { accountLevelMessage } from "./accountLevel.js";
import {
  aliasMatchStrength,
  headerIsPercent,
  normalizeHeader,
  parseFormat,
  parseMetricValue,
  parsePublishedAt,
} from "./values.js";

export interface ColumnMapping {
  title: number | null;
  publishedAt: number | null;
  format: number | null;
  url: number | null;
  /** Metric key -> column index. */
  metrics: Record<string, number>;
}

export interface MappingResult {
  headerRow: number;
  headers: string[];
  mapping: ColumnMapping;
  /** Headers that matched nothing, so the user can see what was ignored. */
  ignoredHeaders: string[];
}

export interface ImportResult {
  posts: Post[];
  mapping: MappingResult;
  notes: string[];
}

function cellText(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return cell.toISOString();
  return String(cell).trim();
}

interface FieldSpec {
  field: string;
  label: string;
  aliases: readonly string[];
}

function fieldSpecs(platform: PlatformId): FieldSpec[] {
  return [
    { field: "title", label: "标题", aliases: columnAliases.title },
    { field: "publishedAt", label: "发布时间", aliases: columnAliases.publishedAt },
    { field: "format", label: "内容形式", aliases: columnAliases.format },
    { field: "url", label: "链接", aliases: columnAliases.url },
    ...getPlatform(platform).metrics.map((metric) => ({
      field: `metric:${metric.key}`,
      label: metric.label,
      aliases: metric.aliases,
    })),
  ];
}

/** Choices offered for each column in the mapping editor. */
export function fieldOptions(platform: PlatformId): Array<{ id: string; label: string }> {
  return fieldSpecs(platform).map((spec) => ({ id: spec.field, label: spec.label }));
}

function matchHeaders(headers: string[], platform: PlatformId): Map<string, number> {
  const assigned = new Map<string, number>();
  const used = new Set<number>();
  for (const spec of fieldSpecs(platform)) {
    // An exact name anywhere beats a name with a unit; within each, aliases are in order of
    // preference and the first one that hits a free column wins.
    search: for (const strength of [2, 1] as const) {
      for (const alias of spec.aliases) {
        const index = headers.findIndex(
          (header, i) => !used.has(i) && aliasMatchStrength(header, alias) === strength,
        );
        if (index >= 0) {
          assigned.set(spec.field, index);
          used.add(index);
          break search;
        }
      }
    }
  }
  return assigned;
}

function toMapping(matches: Map<string, number>): ColumnMapping {
  const metrics: Record<string, number> = {};
  for (const [field, index] of matches) {
    if (field.startsWith("metric:")) metrics[field.slice("metric:".length)] = index;
  }
  return {
    title: matches.get("title") ?? null,
    publishedAt: matches.get("publishedAt") ?? null,
    format: matches.get("format") ?? null,
    url: matches.get("url") ?? null,
    metrics,
  };
}

function buildResult(table: Table, headerRow: number, matches: Map<string, number>): MappingResult {
  const headers = (table[headerRow] ?? []).map(cellText);
  const usedColumns = new Set(matches.values());
  return {
    headerRow,
    headers,
    mapping: toMapping(matches),
    ignoredHeaders: headers.filter((header, index) => header && !usedColumns.has(index)),
  };
}

/** Best guess from column names. Never throws: an incomplete guess is shown for manual fixing. */
export function detectMapping(table: Table, platform: PlatformId): MappingResult {
  let best: { row: number; matches: Map<string, number> } = { row: 0, matches: new Map() };
  for (let row = 0; row < Math.min(table.length, 10); row += 1) {
    const matches = matchHeaders((table[row] ?? []).map(cellText), platform);
    if (matches.size > best.matches.size) best = { row, matches };
  }
  return buildResult(table, best.row, best.matches);
}

export function isComplete(mapping: ColumnMapping): boolean {
  return mapping.title !== null && Object.keys(mapping.metrics).length > 0;
}

function missingParts(mapping: ColumnMapping): string[] {
  const missing: string[] = [];
  if (mapping.title === null) missing.push("标题列");
  if (Object.keys(mapping.metrics).length === 0)
    missing.push("至少一个数据列（比如阅读、播放、点赞）");
  return missing;
}

export function assignmentOf(result: MappingResult): ColumnAssignment {
  const columns: Array<string | null> = result.headers.map(() => null);
  const { mapping } = result;
  for (const field of ["title", "publishedAt", "format", "url"] as const) {
    const index = mapping[field];
    if (index !== null) columns[index] = field;
  }
  for (const [key, index] of Object.entries(mapping.metrics)) columns[index] = `metric:${key}`;
  return { headerRow: result.headerRow, columns };
}

/** Apply a user's column assignment, rejecting unknown fields and fields used twice. */
export function mappingFromAssignment(
  table: Table,
  platform: PlatformId,
  assignment: ColumnAssignment,
): MappingResult {
  if (assignment.headerRow >= table.length) {
    throw new ImportError("invalid_mapping", "表头行超出了表格范围。");
  }
  // A header row with no columns chosen yet: start from the best guess for that row.
  if (assignment.columns.every((field) => !field)) {
    const headers = (table[assignment.headerRow] ?? []).map(cellText);
    return buildResult(table, assignment.headerRow, matchHeaders(headers, platform));
  }
  const specs = new Map(fieldSpecs(platform).map((spec) => [spec.field, spec]));
  const matches = new Map<string, number>();
  assignment.columns.forEach((field, index) => {
    if (!field) return;
    const spec = specs.get(field);
    if (!spec) throw new ImportError("invalid_mapping", `不认识的字段：${field}。`);
    if (matches.has(field)) {
      throw new ImportError("invalid_mapping", `“${spec.label}”同时对应了两列，请只保留一列。`);
    }
    matches.set(field, index);
  });
  return buildResult(table, assignment.headerRow, matches);
}

/** Identity of a header row, used to remember the user's mapping for the same export layout. */
export function headerSignature(headers: string[]): string {
  return headers.map((header) => normalizeHeader(header)).join("|");
}

/** Candidate header rows with their signatures, for looking up saved mappings. */
export function headerCandidates(table: Table): Array<{ row: number; signature: string }> {
  return table
    .slice(0, 10)
    .map((cells, row) => ({ row, signature: headerSignature(cells.map(cellText)) }));
}

const summaryTitles = new Set(["total", "合计", "总计", "汇总", "总和"]);

function parseRows(
  table: Table,
  detected: MappingResult,
  platform: PlatformId,
  asOf: string,
): ImportResult {
  const { mapping } = detected;
  const platformDef = getPlatform(platform);
  const dataRows = table.slice(detected.headerRow + 1);
  if (dataRows.length > maxRows) {
    throw new ImportError(
      "too_many_rows",
      `一次最多导入 ${maxRows} 条，当前有 ${dataRows.length} 条。`,
    );
  }

  const posts: Post[] = [];
  const seen = new Set<string>();
  let skippedSummary = 0;
  let skippedEmpty = 0;
  let duplicates = 0;
  let missingDates = 0;

  for (const row of dataRows) {
    const title = mapping.title === null ? "" : cellText(row[mapping.title]);
    // Summary rows put "合计"/"Total" in the title column or, as YouTube does, in the first cell.
    const firstText = row.map(cellText).find(Boolean) ?? "";
    if (
      summaryTitles.has(title.toLowerCase()) ||
      (!title && summaryTitles.has(firstText.toLowerCase()))
    ) {
      skippedSummary += 1;
      continue;
    }
    const metrics: Record<string, number | null> = {};
    for (const metric of platformDef.metrics) {
      const index = mapping.metrics[metric.key];
      metrics[metric.key] =
        index === undefined
          ? null
          : parseMetricValue(
              row[index],
              metric.kind,
              headerIsPercent(detected.headers[index] ?? ""),
            );
    }
    const hasNumber = Object.values(metrics).some((value) => value !== null);
    if (!title && !hasNumber) {
      skippedEmpty += 1;
      continue;
    }
    const publishedAt =
      mapping.publishedAt === null
        ? null
        : parsePublishedAt(row[mapping.publishedAt] ?? null, asOf);
    if (publishedAt === null) missingDates += 1;
    const key = `${title}::${publishedAt ?? ""}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    posts.push({
      id: `p${posts.length + 1}`,
      title: title.slice(0, 500),
      publishedAt,
      format: mapping.format === null ? null : parseFormat(row[mapping.format]),
      metrics,
      url: mapping.url === null ? null : cellText(row[mapping.url]) || null,
    });
  }

  const notes: string[] = [];
  const metricLabels = Object.keys(mapping.metrics).map(
    (key) => platformDef.metrics.find((metric) => metric.key === key)?.label ?? key,
  );
  notes.push(`识别到的数据列：${metricLabels.join("、") || "无"}。`);
  if (mapping.publishedAt === null)
    notes.push("没有找到发布时间列：无法按时间扣除涨粉影响，也不能检验发布时段。");
  else if (missingDates > 0)
    notes.push(`${missingDates} 条的发布时间无法识别，请在确认表格里补上。`);
  if (skippedSummary > 0) notes.push(`跳过了 ${skippedSummary} 行合计行。`);
  if (skippedEmpty > 0) notes.push(`跳过了 ${skippedEmpty} 行空行。`);
  if (duplicates > 0) notes.push(`合并了 ${duplicates} 条标题和发布时间都相同的重复记录。`);
  if (detected.ignoredHeaders.length > 0)
    notes.push(`未使用的列：${detected.ignoredHeaders.join("、")}。`);

  return { posts, mapping: detected, notes };
}

/** Account totals and daily trends have no per-post rows; mapping their columns only misleads. */
function rejectAccountLevel(table: Table, platform: PlatformId, asOf: string) {
  const message = accountLevelMessage(table, platform, asOf);
  if (message) throw new ImportError("account_level", message);
}

/**
 * Table to posts. With an assignment, the user's column choices are used as given; without
 * one, column names are matched against known aliases.
 */
export function tableToPosts(
  table: Table,
  platform: PlatformId,
  asOf: string,
  assignment?: ColumnAssignment,
): ImportResult {
  rejectAccountLevel(table, platform, asOf);
  const detected = assignment
    ? mappingFromAssignment(table, platform, assignment)
    : detectMapping(table, platform);
  if (!isComplete(detected.mapping)) {
    throw new ImportError(
      "no_header",
      `还缺${missingParts(detected.mapping).join("和")}。请在导入前的“列对应”里手动指定。`,
    );
  }
  return parseRows(table, detected, platform, asOf);
}

/** What the import would look like, for the mapping editor. Never fails on missing columns. */
export function previewImport(
  table: Table,
  platform: PlatformId,
  asOf: string,
  assignment: ColumnAssignment | undefined,
  fromSaved: boolean,
): TableImportPreview {
  rejectAccountLevel(table, platform, asOf);
  const detected = assignment
    ? mappingFromAssignment(table, platform, assignment)
    : detectMapping(table, platform);
  const complete = isComplete(detected.mapping);
  const parsed = complete ? parseRows(table, detected, platform, asOf) : null;
  const width = detected.headers.length;
  const samples = table
    .slice(detected.headerRow + 1, detected.headerRow + 4)
    .map((row) => Array.from({ length: width }, (_, index) => cellText(row[index]).slice(0, 40)));
  return {
    kind: "table",
    headerRow: detected.headerRow,
    headers: detected.headers,
    assignment: assignmentOf(detected),
    complete,
    missing: missingParts(detected.mapping),
    fromSaved,
    samples,
    posts: parsed ? parsed.posts.slice(0, 5) : [],
    dataRows: Math.max(0, table.length - detected.headerRow - 1),
    notes: parsed ? parsed.notes : [],
    fields: fieldOptions(platform),
  };
}
