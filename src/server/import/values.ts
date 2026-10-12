import type { MetricKind } from "../../shared/platforms.js";

const emptyMarkers = new Set(["", "-", "--", "—", "——", "n/a", "na", "null", "暂无", "无", "/"]);

const unitMultipliers: Array<[RegExp, number]> = [
  [/^(.*?)\s*亿$/, 1e8],
  [/^(.*?)\s*万$/, 1e4],
  [/^(.*?)\s*[wW]$/, 1e4],
  [/^(.*?)\s*[kK]$/, 1e3],
  [/^(.*?)\s*千$/, 1e3],
  [/^(.*?)\s*[mM]$/, 1e6],
];

function toHalfWidth(text: string): string {
  return text
    .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ");
}

function parsePlainNumber(text: string): number | null {
  const cleaned = text.replace(/[,\s]/g, "").replace(/\+$/, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function parseCount(text: string): number | null {
  const stripped = text.replace(/\+$/, "").trim();
  for (const [pattern, multiplier] of unitMultipliers) {
    const match = stripped.match(pattern);
    if (match?.[1] !== undefined) {
      const base = parsePlainNumber(match[1]);
      return base === null ? null : Math.round(base * multiplier);
    }
  }
  return parsePlainNumber(stripped);
}

function parseRate(text: string, inPercent: boolean): number | null {
  const percent = text.match(/^(-?[\d.,]+)\s*%$/);
  if (percent?.[1]) {
    const value = parsePlainNumber(percent[1]);
    return value === null ? null : value / 100;
  }
  const value = parsePlainNumber(text);
  if (value === null) return null;
  // A bare number above 1 can only be a percentage ("12.5" in a "点击率" column).
  return inPercent || value > 1 ? value / 100 : value;
}

/** Durations in seconds: "1:23", "01:02:03", "83秒", "1分23秒", "45s", "2.5min". */
function parseDuration(text: string): number | null {
  const clock = text.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (clock) {
    const [, a, b, c] = clock;
    return c === undefined
      ? Number(a) * 60 + Number(b)
      : Number(a) * 3600 + Number(b) * 60 + Number(c);
  }
  const chinese = text.match(
    /^(?:(\d+(?:\.\d+)?)\s*(?:小时|h))?\s*(?:(\d+(?:\.\d+)?)\s*(?:分钟?|min|m))?\s*(?:(\d+(?:\.\d+)?)\s*(?:秒|s))?$/i,
  );
  if (chinese && (chinese[1] || chinese[2] || chinese[3])) {
    return Number(chinese[1] ?? 0) * 3600 + Number(chinese[2] ?? 0) * 60 + Number(chinese[3] ?? 0);
  }
  return parsePlainNumber(text);
}

/** A column header that states its numbers are percentages, like "封面点击率(%)". */
export function headerIsPercent(header: string): boolean {
  return /[%％]/.test(header);
}

/**
 * Turn a cell as it appears in an export or a screenshot into a number. The model never does
 * this conversion; it only transcribes the text it sees. `inPercent` says the column header
 * marks bare numbers as percentages, so "0.8" there is 0.8%, not 80%.
 */
export function parseMetricValue(raw: unknown, kind: MetricKind, inPercent = false): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    if (kind === "rate" && (inPercent || raw > 1)) return raw / 100;
    return raw;
  }
  const text = toHalfWidth(String(raw)).trim();
  if (emptyMarkers.has(text.toLowerCase())) return null;
  if (kind === "rate") return parseRate(text, inPercent);
  if (kind === "duration") return parseDuration(text);
  return parseCount(text);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocal(
  year: number,
  month: number,
  day: number,
  hour?: number,
  minute?: number,
): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1) return null;
  const date = `${year}-${pad(month)}-${pad(day)}`;
  if (hour === undefined || Number.isNaN(hour)) return date;
  if (hour > 23 || (minute ?? 0) > 59) return date;
  return `${date}T${pad(hour)}:${pad(minute ?? 0)}`;
}

/** Spreadsheet dates carry wall-clock time in UTC fields; exactly midnight means "date only". */
function fromUtcDate(date: Date): string | null {
  const midnight = date.getUTCHours() === 0 && date.getUTCMinutes() === 0;
  return formatLocal(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    midnight ? undefined : date.getUTCHours(),
    date.getUTCMinutes(),
  );
}

const monthNames: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function shiftDays(asOf: string, days: number): { year: number; month: number; day: number } {
  const [year, month, day] = asOf.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) - days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/**
 * Publish times are kept as local wall-clock strings ("2026-07-01T20:15" or "2026-07-01"):
 * the hour a creator posted at matters, and time zones would only shift it around.
 * `asOf` (YYYY-MM-DD) resolves relative dates ("3天前") and dates without a year.
 */
export function parsePublishedAt(raw: unknown, asOf: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return fromUtcDate(raw);
  if (typeof raw === "number") {
    // Excel serial date (days since 1899-12-30), as some spreadsheets store them.
    if (raw > 20000 && raw < 80000) {
      return fromUtcDate(new Date(Date.UTC(1899, 11, 30) + Math.round(raw * 86400000)));
    }
    return null;
  }
  const text = toHalfWidth(String(raw)).trim();
  if (!text || emptyMarkers.has(text.toLowerCase())) return null;
  const asOfYear = Number(asOf.slice(0, 4));

  const time = text.match(/(\d{1,2})[:点时](\d{2})?/);
  const hour = time ? Number(time[1]) : undefined;
  const minute = time?.[2] ? Number(time[2]) : 0;

  let match = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (match) return formatLocal(Number(match[1]), Number(match[2]), Number(match[3]), hour, minute);

  match = text.match(/^(\d{1,2})[-/.月](\d{1,2})日?(?:\s|$|\d)/);
  if (match) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    // Without a year, assume the most recent such date not after the reading date.
    const candidate = `${asOfYear}-${pad(month)}-${pad(day)}`;
    const year = candidate > asOf.slice(0, 10) ? asOfYear - 1 : asOfYear;
    return formatLocal(year, month, day, hour, minute);
  }

  match = text.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (match?.[1]) {
    const month = monthNames[match[1].toLowerCase()];
    if (month) return formatLocal(Number(match[3]), month, Number(match[2]), hour, minute);
  }

  const relative: Array<[RegExp, (m: RegExpMatchArray) => number]> = [
    [/^今天/, () => 0],
    [/^昨天/, () => 1],
    [/^前天/, () => 2],
    [/^(\d+)\s*天前/, (m) => Number(m[1])],
    [/^(\d+)\s*(?:小时|分钟)前/, () => 0],
  ];
  for (const [pattern, days] of relative) {
    const found = text.match(pattern);
    if (found) {
      const { year, month, day } = shiftDays(asOf, days(found));
      const keepTime = /^(今天|昨天|前天)/.test(text);
      return formatLocal(year, month, day, keepTime ? hour : undefined, minute);
    }
  }
  return null;
}

/**
 * Lowercase, half-width, no spaces or colons; full-width brackets become ASCII. Soft hyphens
 * and zero-width characters go too: YouTube Studio exports have put soft hyphens inside
 * header words ("Video pub\u00ADlish time", checked on a real 2022 export).
 */
export function normalizeHeader(text: string): string {
  return toHalfWidth(text)
    .toLowerCase()
    .replace(/[\s_：:\uFEFF\u00AD\u200B-\u200D\u2060]/g, "");
}

/** "视频", "图文" and English variants to a content format. */
export function parseFormat(raw: unknown): "video" | "image" | "article" | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().toLowerCase();
  if (!text) return null;
  if (/视频|video|短片|直播回放/.test(text)) return "video";
  if (/图文|图片|笔记|image|photo|carousel/.test(text)) return "image";
  if (/文章|长文|article|post/.test(text)) return "article";
  return null;
}

/** Bracketed units that may follow a metric name: "观看数(人)", "Watch time (hours)". */
const headerUnits = new Set([
  "次",
  "人",
  "人次",
  "个",
  "条",
  "篇",
  "%",
  "s",
  "秒",
  "分",
  "分钟",
  "min",
  "小时",
  "h",
  "hours",
  "天",
  "usd",
  "元",
  "万",
  "w",
]);

/**
 * 2 when the header is the alias, 1 when it is the alias plus a bracketed unit, else 0. Other
 * brackets change the meaning ("Views (co-viewed)" is not "Views"), so they do not match:
 * a column left unmatched is mapped by hand once, while a wrong match silently skews results.
 */
export function aliasMatchStrength(header: string, alias: string): 0 | 1 | 2 {
  const h = normalizeHeader(header);
  const a = normalizeHeader(alias);
  if (!h || !a) return 0;
  if (h === a) return 2;
  const rest = h.startsWith(a) ? h.slice(a.length).match(/^\((.*)\)$/) : null;
  return rest?.[1] !== undefined && headerUnits.has(rest[1]) ? 1 : 0;
}

export function aliasMatches(header: string, alias: string): boolean {
  return aliasMatchStrength(header, alias) > 0;
}
