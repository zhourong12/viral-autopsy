import { columnAliases, getPlatform, type PlatformId } from "../../shared/platforms.js";
import type { Post } from "../../shared/schemas.js";
import { ImportError, maxRows, type Cell, type Table } from "./table.js";
import { normalizeHeader, parseFormat, parseMetricValue, parsePublishedAt } from "./values.js";

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

export function aliasMatches(header: string, alias: string): boolean {
  const h = normalizeHeader(header);
  const a = normalizeHeader(alias);
  if (!h || !a) return false;
  if (h === a) return true;
  // "观看数(人)", "播放量(次)": the alias followed by a bracketed unit.
  return h.startsWith(a) && /^\(.*\)$/.test(h.slice(a.length));
}

interface FieldSpec {
  field: string;
  aliases: readonly string[];
}

function fieldSpecs(platform: PlatformId): FieldSpec[] {
  return [
    { field: "title", aliases: columnAliases.title },
    { field: "publishedAt", aliases: columnAliases.publishedAt },
    { field: "format", aliases: columnAliases.format },
    { field: "url", aliases: columnAliases.url },
    ...getPlatform(platform).metrics.map((metric) => ({
      field: `metric:${metric.key}`,
      aliases: metric.aliases,
    })),
  ];
}

function matchHeaders(headers: string[], platform: PlatformId): Map<string, number> {
  const assigned = new Map<string, number>();
  const used = new Set<number>();
  for (const spec of fieldSpecs(platform)) {
    // Aliases are ordered by preference, so the first alias that hits any free column wins.
    for (const alias of spec.aliases) {
      const index = headers.findIndex((header, i) => !used.has(i) && aliasMatches(header, alias));
      if (index >= 0) {
        assigned.set(spec.field, index);
        used.add(index);
        break;
      }
    }
  }
  return assigned;
}

export function detectMapping(table: Table, platform: PlatformId): MappingResult {
  let best: { row: number; matches: Map<string, number> } | null = null;
  for (let row = 0; row < Math.min(table.length, 10); row += 1) {
    const headers = (table[row] ?? []).map(cellText);
    const matches = matchHeaders(headers, platform);
    if (!best || matches.size > best.matches.size) best = { row, matches };
  }
  if (!best || best.matches.size < 2 || !best.matches.has("title")) {
    throw new ImportError(
      "no_header",
      "没有找到表头。表格至少需要“标题”列和一个数据列（比如阅读、播放、点赞）。",
    );
  }
  const headers = (table[best.row] ?? []).map(cellText);
  const metrics: Record<string, number> = {};
  for (const [field, index] of best.matches) {
    if (field.startsWith("metric:")) metrics[field.slice("metric:".length)] = index;
  }
  const usedColumns = new Set(best.matches.values());
  return {
    headerRow: best.row,
    headers,
    mapping: {
      title: best.matches.get("title") ?? null,
      publishedAt: best.matches.get("publishedAt") ?? null,
      format: best.matches.get("format") ?? null,
      url: best.matches.get("url") ?? null,
      metrics,
    },
    ignoredHeaders: headers.filter((header, index) => header && !usedColumns.has(index)),
  };
}

const summaryTitles = new Set(["total", "合计", "总计", "汇总", "总和"]);

export function tableToPosts(table: Table, platform: PlatformId, asOf: string): ImportResult {
  const detected = detectMapping(table, platform);
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
      metrics[metric.key] = index === undefined ? null : parseMetricValue(row[index], metric.kind);
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
