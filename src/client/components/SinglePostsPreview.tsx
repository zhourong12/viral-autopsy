import type { PlatformDef } from "../../shared/platforms.js";
import type { PostsImportPreview } from "../../shared/schemas.js";
import { formatNumber } from "./PostTable.js";
import { Notice } from "./ui.js";

/** Files that each hold one post's export: one row per file, before importing them. */
export function SinglePostsPreview({
  preview,
  platform,
}: {
  preview: PostsImportPreview;
  platform: PlatformDef;
}) {
  const metrics = platform.metrics.filter((metric) =>
    preview.posts.some((post) => post.metrics[metric.key] !== null),
  );
  return (
    <section aria-labelledby="single-posts-title" style={{ display: "grid", gap: 10 }}>
      <h3 id="single-posts-title">每个文件一篇{platform.contentNoun}</h3>
      <Notice kind="info">
        <ul>
          {preview.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </Notice>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">标题（取自文件名）</th>
              <th scope="col">发布时间（估算）</th>
              {metrics.map((metric) => (
                <th key={metric.key} scope="col" className="num">
                  {metric.label}
                  {metric.kind === "duration" ? "（秒）" : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.posts.map((post) => (
              <tr key={post.id}>
                <td>{post.title || "（无标题）"}</td>
                <td className="mono small">{post.publishedAt?.replace("T", " ") ?? "—"}</td>
                {metrics.map((metric) => (
                  <td key={metric.key} className="num">
                    {formatNumber(post.metrics[metric.key], metric.kind) || "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
