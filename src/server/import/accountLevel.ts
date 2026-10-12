import { getPlatform, type PlatformId } from "../../shared/platforms.js";
import type { Cell, Table } from "./table.js";
import { aliasMatches, parseMetricValue, parsePublishedAt } from "./values.js";

/**
 * Data centres also export account-level numbers: totals with one metric per row, and daily
 * trends with one day per row (Xiaohongshu's "近30日观看数据" holds both, checked 2026-10-12).
 * Neither has per-post rows, and both are the first export people find, so they are recognised
 * and explained rather than offered for column mapping.
 */

function filled(row: Cell[]): Cell[] {
  return row.filter((cell) => cell !== null && String(cell).trim() !== "");
}

function isNumberLike(cell: Cell): boolean {
  if (typeof cell === "number") return true;
  if (cell instanceof Date || cell === null) return false;
  return (
    parseMetricValue(cell, "count") !== null ||
    parseMetricValue(cell, "rate") !== null ||
    parseMetricValue(cell, "duration") !== null
  );
}

/** Metric names down the first column ("曝光 | 3643"), each with a value or two beside it. */
function isTotalsTable(table: Table, platform: PlatformId): boolean {
  const metrics = getPlatform(platform).metrics;
  const isMetricName = (cell: Cell) =>
    typeof cell === "string" &&
    metrics.some((metric) => metric.aliases.some((alias) => aliasMatches(cell, alias)));
  const metricRows = table.filter((row) => {
    const [label, ...values] = filled(row);
    return (
      label !== undefined &&
      isMetricName(label) &&
      values.length >= 1 &&
      values.length <= 2 &&
      values.every(isNumberLike)
    );
  });
  return metricRows.length >= 2;
}

/** One distinct date per row with only numbers beside it, so no column can be post titles. */
function isDailyTable(table: Table, asOf: string): boolean {
  const rows = table.slice(1).map(filled);
  const dates = new Set<string>();
  let dayRows = 0;
  for (const [first, ...values] of rows) {
    if (first === undefined || typeof first === "number") continue;
    const date = parsePublishedAt(first, asOf);
    if (date === null || date.length !== 10 || values.length === 0) continue;
    if (!values.every(isNumberLike)) continue;
    dates.add(date);
    dayRows += 1;
  }
  return dayRows >= 3 && dayRows >= rows.length * 0.8 && dates.size === dayRows;
}

/** Why this table cannot be autopsied and what to export instead, or null for per-post data. */
export function accountLevelMessage(
  table: Table,
  platform: PlatformId,
  asOf: string,
): string | null {
  const what = isTotalsTable(table, platform)
    ? "这份是账号整体的合计数据（每行是一个指标，比如曝光、观看）"
    : isDailyTable(table, asOf)
      ? "这份是按天汇总的账号数据（每行是一天）"
      : null;
  if (!what) return null;
  const { label, contentNoun } = getPlatform(platform);
  return `${what}，没有分到每篇${contentNoun}，没法比较哪篇好、为什么好。请在${label}后台找按${contentNoun}列出的明细（每行一篇${contentNoun}，有标题和数据），能导出就导出；不能导出就截那个列表页，用截图导入。`;
}
