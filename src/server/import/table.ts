import Papa from "papaparse";
import readXlsxFile, { readSheetNames } from "read-excel-file/node";

export type Cell = string | number | Date | null;
export type Table = Cell[][];

/** One sheet of a workbook; CSV and pasted text are a single sheet with no name. */
export interface Sheet {
  name: string;
  table: Table;
}

export class ImportError extends Error {
  constructor(
    readonly code:
      | "empty_file"
      | "unsupported_file"
      | "unreadable_file"
      | "no_header"
      | "invalid_mapping"
      | "too_many_rows"
      | "account_level"
      | "mixed_files",
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

const unreadableXlsx = "无法读取这个 Excel 文件。只支持 .xlsx；旧版 .xls 请另存为 .xlsx 或 CSV。";

/** Every sheet that holds data, in workbook order. */
export async function parseWorkbook(buffer: Buffer): Promise<Sheet[]> {
  const sheets: Sheet[] = [];
  try {
    const names = await readSheetNames(buffer);
    for (const [index, name] of names.entries()) {
      const rows = await readXlsxFile(buffer, { sheet: index + 1 });
      const table = rows
        .map((row) =>
          row.map((cell) => (cell === null || cell === undefined ? null : (cell as Cell))),
        )
        .filter((row) => row.some((cell) => cell !== null && String(cell).trim() !== ""));
      if (table.length > 0) sheets.push({ name, table });
    }
  } catch {
    throw new ImportError("unreadable_file", unreadableXlsx);
  }
  if (sheets.length === 0) throw new ImportError("empty_file", "表格里没有数据行。");
  return sheets;
}

/** .xlsx is a zip archive and .xls an OLE file, so files that lost their extension still open. */
function sniff(buffer: Buffer): "xlsx" | "xls" | null {
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return "xlsx";
  if (buffer.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) return "xls";
  return null;
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

const xlsNotSupported = "暂不支持旧版 .xls，请在表格软件里另存为 .xlsx 或 CSV。";

export async function parseImportFile(
  fileName: string,
  content: string,
  encoding: "text" | "base64",
): Promise<Sheet[]> {
  const buffer = encoding === "base64" ? Buffer.from(content, "base64") : null;
  const kind = buffer ? sniff(buffer) : null;
  if (buffer && kind === "xlsx") return parseWorkbook(buffer);
  if (kind === "xls") throw new ImportError("unsupported_file", xlsNotSupported);
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx")) {
    if (!buffer) throw new ImportError("unsupported_file", "Excel 文件需要以二进制上传。");
    // Douyin hands out a short JSON error under the .xlsx name when the login has expired
    // (reported by a public export tool).
    if (/^\s*[{[]/.test(buffer.subarray(0, 64).toString("utf8"))) {
      throw new ImportError(
        "unreadable_file",
        "这个文件不是表格，而是后台返回的一段错误信息，常见原因是登录过期。请刷新后台页面、重新登录后再导出一次。",
      );
    }
    throw new ImportError("unreadable_file", unreadableXlsx);
  }
  if (lower.endsWith(".xls")) throw new ImportError("unsupported_file", xlsNotSupported);
  if (
    lower.endsWith(".csv") ||
    lower.endsWith(".tsv") ||
    lower.endsWith(".txt") ||
    !lower.includes(".")
  ) {
    const text = buffer ? decodeText(buffer) : content;
    return [{ name: "", table: parseDelimitedText(text) }];
  }
  throw new ImportError("unsupported_file", "只支持 CSV、TSV 和 .xlsx 文件。");
}
