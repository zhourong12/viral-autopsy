import { Plus, Trash2 } from "lucide-react";
import type { PlatformDef } from "../../shared/platforms.js";
import type { Post } from "../../shared/schemas.js";

interface Props {
  platform: PlatformDef;
  posts: Post[];
  uncertain: Record<string, string[]>;
  onChange(posts: Post[]): void;
}

function formatNumber(value: number | null | undefined, kind: string): string {
  if (value === null || value === undefined) return "";
  if (kind === "rate") return `${Math.round(value * 1000) / 10}%`;
  return String(value);
}

/** What the user types back into a number: "12.5%" for rates, plain numbers otherwise. */
function parseInput(text: string, kind: string): number | null {
  const trimmed = text.trim().replace(/,/g, "");
  if (!trimmed) return null;
  if (kind === "rate") {
    const value = Number(trimmed.replace(/%$/, ""));
    if (!Number.isFinite(value)) return null;
    return trimmed.endsWith("%") || value > 1 ? value / 100 : value;
  }
  const unit = trimmed.match(/^(-?[\d.]+)\s*(万|w|W)$/);
  if (unit?.[1]) return Math.round(Number(unit[1]) * 10000);
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Editable grid for checking imported numbers. Cells the AI was unsure about are highlighted. */
export function PostTable({ platform, posts, uncertain, onChange }: Props) {
  const metrics = platform.metrics.filter(
    (metric) =>
      posts.some(
        (post) => post.metrics[metric.key] !== null && post.metrics[metric.key] !== undefined,
      ) || posts.some((post) => (uncertain[post.id] ?? []).includes(metric.key)),
  );

  function update(index: number, patch: Partial<Post>) {
    onChange(posts.map((post, i) => (i === index ? { ...post, ...patch } : post)));
  }

  function addRow() {
    const used = new Set(posts.map((post) => post.id));
    let n = posts.length + 1;
    while (used.has(`p${n}`)) n += 1;
    const blank: Post = {
      id: `p${n}`,
      title: "",
      publishedAt: null,
      format: null,
      metrics: {},
      url: null,
    };
    onChange([...posts, blank]);
  }

  return (
    <div className="grid-editor table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">标题</th>
            <th scope="col">发布时间</th>
            {metrics.map((metric) => (
              <th key={metric.key} scope="col">
                {metric.label}
              </th>
            ))}
            <th scope="col">
              <span className="sr-only">删除</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {posts.map((post, index) => {
            const unsure = new Set(uncertain[post.id] ?? []);
            return (
              <tr key={post.id}>
                <td className="num muted">{index + 1}</td>
                <td>
                  <input
                    className={`cell-input title${unsure.has("title") ? " uncertain" : ""}`}
                    aria-label={`第 ${index + 1} 条标题`}
                    value={post.title}
                    onChange={(event) => update(index, { title: event.target.value })}
                  />
                </td>
                <td>
                  <input
                    className={`cell-input date${unsure.has("publishedText") || !post.publishedAt ? " uncertain" : ""}`}
                    aria-label={`第 ${index + 1} 条发布时间`}
                    placeholder="2026-07-01T20:15"
                    defaultValue={post.publishedAt ?? ""}
                    onBlur={(event) => {
                      const value = event.target.value.trim();
                      const valid = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(value);
                      update(index, { publishedAt: valid ? value : null });
                      if (value && !valid) event.target.value = post.publishedAt ?? "";
                    }}
                  />
                </td>
                {metrics.map((metric) => (
                  <td key={metric.key}>
                    <input
                      className={`cell-input mono${unsure.has(metric.key) ? " uncertain" : ""}`}
                      aria-label={`第 ${index + 1} 条${metric.label}`}
                      inputMode="decimal"
                      defaultValue={formatNumber(post.metrics[metric.key], metric.kind)}
                      onBlur={(event) =>
                        update(index, {
                          metrics: {
                            ...post.metrics,
                            [metric.key]: parseInput(event.target.value, metric.kind),
                          },
                        })
                      }
                    />
                  </td>
                ))}
                <td>
                  <button
                    type="button"
                    className="btn danger"
                    aria-label={`删除第 ${index + 1} 条`}
                    onClick={() => onChange(posts.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ padding: 10 }}>
        <button type="button" className="btn" onClick={addRow}>
          <Plus size={14} aria-hidden="true" />
          加一行
        </button>
      </div>
    </div>
  );
}
