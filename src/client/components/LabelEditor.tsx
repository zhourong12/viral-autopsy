import type { Post, PostLabels } from "../../shared/schemas.js";
import { emptyLabels, hookTypeLabels, hookTypes } from "../../shared/schemas.js";

interface Props {
  posts: Post[];
  labels: Record<string, PostLabels>;
  onChange(labels: Record<string, PostLabels>): void;
}

const flags: Array<{
  key: "isTutorial" | "emotional" | "personalStory" | "coverFace" | "coverBigText";
  label: string;
}> = [
  { key: "isTutorial", label: "教程干货" },
  { key: "emotional", label: "强情绪" },
  { key: "personalStory", label: "个人经历" },
  { key: "coverFace", label: "封面露脸" },
  { key: "coverBigText", label: "封面大字" },
];

function cycle(value: boolean | null): boolean | null {
  return value === null ? true : value ? false : null;
}

function flagText(value: boolean | null): string {
  return value === null ? "未标" : value ? "是" : "否";
}

/** Labels per post. Every flag cycles 未标 → 是 → 否, so "unknown" stays distinct from "no". */
export function LabelEditor({ posts, labels, onChange }: Props) {
  function update(postId: string, patch: Partial<PostLabels>) {
    onChange({ ...labels, [postId]: { ...emptyLabels, ...labels[postId], ...patch } });
  }

  return (
    <div className="grid-editor table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">标题</th>
            <th scope="col">钩子</th>
            <th scope="col">选题</th>
            {flags.map((flag) => (
              <th key={flag.key} scope="col">
                {flag.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {posts.map((post) => {
            const current = { ...emptyLabels, ...labels[post.id] };
            return (
              <tr key={post.id}>
                <td style={{ minWidth: 240 }}>
                  {post.title || <span className="muted">（无标题）</span>}
                </td>
                <td>
                  <select
                    className="cell-input"
                    aria-label={`${post.title} 的钩子类型`}
                    value={current.hookType ?? ""}
                    onChange={(event) =>
                      update(post.id, {
                        hookType: (event.target.value || null) as PostLabels["hookType"],
                      })
                    }
                  >
                    <option value="">未标</option>
                    {hookTypes.map((hook) => (
                      <option key={hook} value={hook}>
                        {hookTypeLabels[hook]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    className="cell-input"
                    aria-label={`${post.title} 的选题`}
                    defaultValue={current.topic ?? ""}
                    maxLength={20}
                    onBlur={(event) =>
                      update(post.id, { topic: event.target.value.trim() || null })
                    }
                  />
                </td>
                {flags.map((flag) => (
                  <td key={flag.key}>
                    <button
                      type="button"
                      className="btn"
                      style={{ padding: "2px 10px" }}
                      aria-label={`${post.title}：${flag.label}，当前${flagText(current[flag.key])}，点击切换`}
                      onClick={() => update(post.id, { [flag.key]: cycle(current[flag.key]) })}
                    >
                      {flagText(current[flag.key])}
                    </button>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
