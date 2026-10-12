import type { ColumnAssignment, TableImportPreview } from "../../shared/schemas.js";
import { Notice } from "./ui.js";

interface Props {
  preview: TableImportPreview;
  onChange(assignment: ColumnAssignment): void;
}

/**
 * One row per column: the header, a few sample values and the field it should be read as.
 * Used when a platform's real export does not match the known column names.
 */
export function ColumnMapper({ preview, onChange }: Props) {
  const { assignment, headers, samples, fields } = preview;
  const used = new Map<string, number>();
  assignment.columns.forEach((field) => {
    if (field) used.set(field, (used.get(field) ?? 0) + 1);
  });

  function setColumn(index: number, field: string | null) {
    const columns = headers.map((_, i) => assignment.columns[i] ?? null);
    // A field belongs to one column: picking it here clears it elsewhere.
    if (field) {
      columns.forEach((existing, i) => {
        if (existing === field) columns[i] = null;
      });
    }
    columns[index] = field;
    onChange({ headerRow: assignment.headerRow, columns });
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="row">
        <label className="field" style={{ maxWidth: 220 }}>
          表头在第几行
          <select
            value={assignment.headerRow}
            onChange={(event) => onChange({ headerRow: Number(event.target.value), columns: [] })}
          >
            {Array.from({ length: 10 }, (_, row) => (
              <option key={row} value={row}>
                第 {row + 1} 行
              </option>
            ))}
          </select>
        </label>
        {preview.fromSaved && <span className="chip ai">已套用你上次为这种表头保存的对应关系</span>}
      </div>
      {preview.missing.length > 0 && (
        <Notice kind="warn">还缺{preview.missing.join("和")}，请在下面指定。</Notice>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">表格里的列</th>
              <th scope="col">示例</th>
              <th scope="col">当作</th>
            </tr>
          </thead>
          <tbody>
            {headers.map((header, index) => {
              const field = assignment.columns[index] ?? null;
              const examples = samples
                .map((row) => row[index] ?? "")
                .filter(Boolean)
                .slice(0, 3);
              return (
                <tr key={`${index}-${header}`}>
                  <td>
                    <strong>{header || `（第 ${index + 1} 列，无列名）`}</strong>
                  </td>
                  <td className="small muted">{examples.join(" / ") || "—"}</td>
                  <td>
                    <select
                      className="cell-input"
                      aria-label={`“${header || `第 ${index + 1} 列`}”当作`}
                      value={field ?? ""}
                      onChange={(event) => setColumn(index, event.target.value || null)}
                    >
                      <option value="">不使用</option>
                      {fields.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                          {used.has(option.id) && option.id !== field ? "（已在别的列）" : ""}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {preview.complete && preview.posts.length > 0 && (
        <div className="small">
          <p className="muted">按现在的对应关系，前几条会读成这样（共 {preview.dataRows} 行）：</p>
          <ul>
            {preview.posts.slice(0, 3).map((post) => (
              <li key={post.id}>
                {post.title || "（无标题）"} · {post.publishedAt ?? "无发布时间"} ·{" "}
                {Object.entries(post.metrics)
                  .filter(([, value]) => value !== null)
                  .map(([key, value]) => {
                    const label = fields.find((option) => option.id === `metric:${key}`)?.label;
                    return `${label ?? key} ${value}`;
                  })
                  .join("，")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
