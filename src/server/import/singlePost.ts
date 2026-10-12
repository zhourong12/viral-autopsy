import { getPlatform, type PlatformId } from "../../shared/platforms.js";
import type { Post } from "../../shared/schemas.js";
import { filled, isNumberLike, totalsRows } from "./accountLevel.js";
import { ImportError, type Sheet, type Table } from "./table.js";
import { headerIsPercent, parseMetricValue, parsePublishedAt } from "./values.js";

/**
 * Xiaohongshu's data centre exports one note per file (checked 2026-10-12 on a real export): a
 * "基础数据总览" sheet with the note's totals down the first column, then daily "（天）" and
 * hourly "（小时）" trend sheets that start when the note went out. The title is only in the
 * file name and the publish time is not in the file, so they come from the file name and the
 * earliest trend timestamp, and the user confirms both in the check table.
 */

/** Times of a trend sheet: a date or hour in the first cell, only numbers beside it. */
function trendTimes(table: Table, asOf: string): string[] {
  const rows = table.slice(1).map(filled);
  const times = rows.flatMap(([first, ...values]) => {
    if (first === undefined || typeof first === "number" || values.length === 0) return [];
    if (!values.every(isNumberLike)) return [];
    const time = parsePublishedAt(first, asOf);
    return time ? [time] : [];
  });
  return times.length >= rows.length * 0.8 ? times : [];
}

/** Earliest day, at the earliest hour recorded on that day when there is hourly data. */
function earliest(times: string[]): string | null {
  const day = times.map((time) => time.slice(0, 10)).sort()[0];
  if (!day) return null;
  const hours = times.filter((time) => time.startsWith(day) && time.length > 10).sort();
  return hours[0] ?? day;
}

/** The account export has the same shape, so its own markers rule it out. */
function isAccountWorkbook(sheets: Sheet[]): boolean {
  return sheets.some(
    (sheet) =>
      sheet.name.includes("账号") ||
      sheet.table.some((row) => String(row[0] ?? "").includes("环比")),
  );
}

/** File name without its extension or the "(1)" a browser adds to repeated downloads. */
function titleFromFileName(fileName: string): string {
  return fileName
    .replace(/\.(xlsx|xls|csv|tsv|txt)$/i, "")
    .replace(/\s*[(（]\d+[)）]$/, "")
    .trim();
}

/** One post from a single-post export, or null when the workbook is not one. */
export function readSinglePostExport(
  sheets: Sheet[],
  fileName: string,
  platform: PlatformId,
  asOf: string,
): Omit<Post, "id"> | null {
  const [summary, ...trends] = sheets;
  if (!summary || trends.length === 0 || isAccountWorkbook(sheets)) return null;
  const rows = totalsRows(summary.table, platform);
  if (rows.length < 2) return null;
  const publishedAt = earliest(trends.flatMap((sheet) => trendTimes(sheet.table, asOf)));
  if (!publishedAt) return null;

  const metrics: Record<string, number | null> = Object.fromEntries(
    getPlatform(platform).metrics.map((metric) => [metric.key, null]),
  );
  for (const row of rows) {
    if (metrics[row.metric.key] !== null) continue;
    metrics[row.metric.key] = parseMetricValue(
      row.value,
      row.metric.kind,
      headerIsPercent(row.label),
    );
  }
  return { title: titleFromFileName(fileName), publishedAt, format: null, metrics, url: null };
}

const separators = new Set(["-", "_", "—", "–", "|", "｜", "丨", "·"]);

/**
 * Text that every file name repeats, such as a "-笔记数据" an export adds, is not part of any
 * title. It is removed only when set off by a separator, and only across two or more titles.
 */
export function stripSharedAffixes(titles: string[]): { titles: string[]; removed: string[] } {
  const distinct = [...new Set(titles)].map((title) => Array.from(title));
  const first = distinct[0];
  if (!first || distinct.length < 2) return { titles, removed: [] };
  const shortest = Math.min(...distinct.map((chars) => chars.length));
  const shared = (at: (chars: string[], i: number) => string | undefined) => {
    let length = 0;
    while (length < shortest && distinct.every((chars) => at(chars, length) === at(first, length)))
      length += 1;
    return length;
  };
  const suffixLength = shared((chars, i) => chars[chars.length - 1 - i]);
  const prefixLength = shared((chars, i) => chars[i]);

  // Keep the shared part only from its first separator on (suffix) or up to its last (prefix).
  const suffix = first.slice(first.length - suffixLength);
  const suffixStart = suffix.findIndex((char) => separators.has(char));
  const prefix = first.slice(0, prefixLength);
  const prefixEnd = prefix.findLastIndex((char) => separators.has(char));
  const cutEnd = suffixStart >= 0 ? suffix.length - suffixStart : 0;
  const cutStart = prefixEnd >= 0 ? prefixEnd + 1 : 0;
  if (cutEnd === 0 && cutStart === 0) return { titles, removed: [] };

  const stripped = titles.map((title) => {
    const chars = Array.from(title);
    return chars
      .slice(cutStart, chars.length - cutEnd)
      .join("")
      .trim();
  });
  if (stripped.some((title) => !title)) return { titles, removed: [] };
  const removed = [
    cutStart > 0 ? prefix.slice(0, cutStart).join("").trim() : "",
    cutEnd > 0 ? suffix.slice(suffixStart).join("").trim() : "",
  ].filter(Boolean);
  return { titles: stripped, removed };
}

/**
 * Posts from files that are each one post's export. Null when a lone file is something else
 * (a per-post table goes through column mapping); several files must all be single-post exports.
 */
export function postsFromSinglePostExports(
  files: Array<{ fileName: string; sheets: Sheet[] }>,
  platform: PlatformId,
  asOf: string,
): { posts: Post[]; notes: string[] } | null {
  const read = files.map((file) => ({
    fileName: file.fileName,
    post: readSinglePostExport(file.sheets, file.fileName, platform, asOf),
  }));
  const others = read.filter((item) => item.post === null).map((item) => item.fileName);
  const def = getPlatform(platform);
  if (others.length > 0) {
    if (files.length === 1) return null;
    throw new ImportError(
      "mixed_files",
      `一次选多个文件时，每个文件都要是单篇${def.contentNoun}的数据导出。这些不是：${others.join("、")}。按${def.contentNoun}列出的表格请单独导入。`,
    );
  }

  const readPosts = read.flatMap((item) => (item.post ? [item.post] : []));
  const cleaned = stripSharedAffixes(readPosts.map((post) => post.title));
  const posts: Post[] = [];
  const seen = new Set<string>();
  readPosts.forEach((post, index) => {
    const title = cleaned.titles[index] ?? post.title;
    const key = `${title}::${post.publishedAt ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    posts.push({ id: `p${posts.length + 1}`, ...post, title });
  });
  const found = def.metrics
    .filter((metric) => posts.some((post) => post.metrics[metric.key] !== null))
    .map((metric) => metric.label);
  const notes = [
    `识别为 ${posts.length} 篇单篇${def.contentNoun}的数据导出，每个文件算一篇。`,
    `识别到的数据：${found.join("、") || "无"}。`,
    "标题取自文件名，发布时间按数据里最早的记录估算，核对表格时请确认。",
  ];
  if (cleaned.removed.length > 0) {
    notes.push(
      `每个文件名都带着“${cleaned.removed.join("”和“")}”，已从标题里去掉；如果它本来就是标题的一部分，请在表格里改回来。`,
    );
  }
  if (posts.length < read.length) {
    notes.push(`合并了 ${read.length - posts.length} 个标题和发布时间都相同的重复文件。`);
  }
  return { posts, notes };
}
