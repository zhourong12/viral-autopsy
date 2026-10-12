import writeXlsxFile from "write-excel-file/node";
import type { Sheet } from "./table.js";

/**
 * Test workbooks in the layouts of real Xiaohongshu data-centre exports (checked 2026-10-12).
 * Sheet names, labels and value styles are copied from the real files; the numbers are made up.
 */

/** One note's export: totals down the first column, then daily and hourly trends. */
export function noteExport(options: {
  startDay: string;
  impressions: number;
  views: number;
  ctrPercent: number;
}): Sheet[] {
  const [year, month, day] = options.startDay.split("-");
  const date = (offset: number) =>
    `${year}年${month}月${String(Number(day) + offset).padStart(2, "0")}日`;
  return [
    {
      name: "基础数据总览",
      table: [
        ["指标", "数值"],
        ["曝光数 ", options.impressions],
        ["观看数 ", options.views],
        ["封面点击率(%) ", options.ctrPercent],
        ["平均观看时长(s) ", 8.5],
        ["完播率(%) ", 0],
        ["2秒退出率(%) ", 0],
        ["涨粉数 ", 2],
        ["曝光数粉丝占比(%) ", 0.5],
      ],
    },
    {
      name: "曝光数（天）",
      table: [
        ["日期", "曝光数"],
        [date(0), Math.round(options.impressions * 0.8)],
        [date(1), Math.round(options.impressions * 0.15)],
        [date(2), Math.round(options.impressions * 0.05)],
      ],
    },
    {
      name: "平均观看时长（小时）",
      table: [
        ["时刻", "人均观看时长"],
        [`${date(0)}09时`, "23s"],
        [`${date(0)}10时`, "21s"],
        [`${date(1)}08时`, "70s"],
      ],
    },
  ];
}

/** The account's "近30日观看数据": totals with period-over-period rows, then daily trends. */
export function accountExport(): Sheet[] {
  return [
    {
      name: "账号总体观看数据",
      table: [
        ["指标", "数值"],
        ["曝光", 1200],
        ["观看", 300],
        ["封面点击率(%)", 12.5],
        ["曝光环比(%)", 150],
      ],
    },
    {
      name: "曝光趋势",
      table: [
        ["日期", "数值"],
        ["2026年10月11日", 16],
        ["2026年10月10日", 2],
        ["2026年10月09日", 10],
      ],
    },
  ];
}

export function toXlsx(sheets: Sheet[]): Promise<Buffer> {
  return writeXlsxFile(
    sheets.map((sheet) => ({
      sheet: sheet.name,
      data: sheet.table.map((row) => row.map((value) => (value === null ? null : { value }))),
    })),
  ).toBuffer();
}
