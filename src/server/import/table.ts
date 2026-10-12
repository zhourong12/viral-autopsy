import Papa from "papaparse";
import readXlsxFile from "read-excel-file/node";

export type Cell = string | number | Date | null;
export type Table = Cell[][];

export class ImportError extends Error {
  constructor(
    readonly code:
      | "empty_file"
      | "unsupported_file"
      | "unreadable_file"
      | "no_header"
      | "invalid_mapping"
      | "too_many_rows",
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export const maxRows = 1000;

/** CSV or TSV text (delimiter detected), with a UTF-8 BOM tolerated. */
export function parseDelimitedText(text: string): Table {
  const cleaned = text.replace(/^\uFEFF/, "");
  if (!cleaned.trim()) throw new ImportError("empty_file", "文件是空的。");
  const result = Papa.parse<string[]>(cleaned, { skipEmptyLines: "greedy" });
  const rows = result.data.filter((row) => row.some((cell) => String(cell).trim() !== ""));
  if (rows.length === 0) throw new ImportError("empty_file", "文件里没有数据行。");
  return rows.map((row) => row.map((cell) => (cell === "" ? null : cell)));
}

export async function parseXlsx(buffer: Buffer): Promise<Table> {
  let rows;
  try {
    rows = await readXlsxFile(buffer);
  } catch {
    throw new ImportError(
      "unreadable_file",
      "无法读取这个 Excel 文件。只支持 .xlsx；旧版 .xls 请另存为 .xlsx 或 CSV。",
    );
  }
  const table = rows
    .map((row) => row.map((cell) => (cell === null || cell === undefined ? null : (cell as Cell))))
    .filter((row) => row.some((cell) => cell !== null && String(cell).trim() !== ""));
  if (table.length === 0) throw new ImportError("empty_file", "表格里没有数据行。");
  return table;
}

/**
 * Exports saved by Excel on Chinese Windows are often GB18030/GBK, not UTF-8. Try strict UTF-8
 * first and fall back to GB18030 (a superset of GBK).
 */
export function decodeText(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("gb18030").decode(buffer);
  }
}

export async function parseImportFile(
  fileName: string,
  content: string,
  encoding: "text" | "base64",
): Promise<Table> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx")) {
    if (encoding !== "base64")
      throw new ImportError("unsupported_file", "Excel 文件需要以二进制上传。");
    return parseXlsx(Buffer.from(content, "base64"));
  }
  if (lower.endsWith(".xls")) {
    throw new ImportError(
      "unsupported_file",
      "暂不支持旧版 .xls，请在表格软件里另存为 .xlsx 或 CSV。",
    );
  }
  if (
    lower.endsWith(".csv") ||
    lower.endsWith(".tsv") ||
    lower.endsWith(".txt") ||
    !lower.includes(".")
  ) {
    const text = encoding === "base64" ? decodeText(Buffer.from(content, "base64")) : content;
    return parseDelimitedText(text);
  }
  throw new ImportError("unsupported_file", "只支持 CSV、TSV 和 .xlsx 文件。");
}
