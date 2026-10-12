import { comparisonText, formatMetric, standoutText } from "../../shared/format.js";
import type { PlatformDef } from "../../shared/platforms.js";
import type { StarterReport } from "../../shared/schemas.js";

/**
 * New accounts: each post against the account's typical post. Descriptive only; the
 * experiments below are how a pattern gets confirmed.
 */
export function StarterCheckup({
  starter,
  platform,
  metric,
}: {
  starter: StarterReport;
  platform: PlatformDef;
  metric: string;
}) {
  const metricInfo = platform.metrics.find((item) => item.key === metric);
  const kind = metricInfo?.kind ?? "count";
  const noun = platform.contentNoun;
  const remaining = Math.max(0, starter.target - starter.postsSettled);
  return (
    <section className="panel" aria-labelledby="starter-title">
      <div className="panel-head">
        <h2 id="starter-title">新号体检</h2>
        <span className="chip">
          {starter.postsSettled} / {starter.target} 篇
        </span>
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-label="离能判断规律的篇数"
        aria-valuemin={0}
        aria-valuemax={starter.target}
        aria-valuenow={starter.postsSettled}
      >
        <span style={{ width: `${(starter.postsSettled / starter.target) * 100}%` }} />
      </div>
      <p className="small muted">
        发布满 {platform.maturityDays} 天的{noun}还有 {remaining}{" "}
        篇才到能判断规律的量。在那之前，下面只是每篇和你其他{noun}
        的一般水平（中位数）比，用来看出哪篇不一样、不一样在哪里，不代表规律；规律靠下面的实验来验证。
      </p>
      <div className="table-wrap checkups">
        <table>
          <thead>
            <tr>
              <th scope="col">{noun}</th>
              <th scope="col" className="num">
                {metricInfo?.label ?? metric}
              </th>
              <th scope="col">和一般水平比</th>
              <th scope="col">不一样的地方</th>
            </tr>
          </thead>
          <tbody>
            {starter.checkups.map((item) => (
              <tr key={item.postId}>
                <td>
                  {item.title || "（无标题）"}
                  <div className="small muted mono">
                    {item.publishedAt?.replace("T", " ") ?? "无发布时间"}
                    {item.settling && `\u3000发布不满 ${platform.maturityDays} 天，数字还会涨`}
                  </div>
                </td>
                <td className="num">
                  <span className="cell-label">{metricInfo?.label ?? metric}：</span>
                  {item.value === null ? "—" : formatMetric(item.value, kind)}
                </td>
                <td className="small">
                  <span className="cell-label">和一般水平比：</span>
                  {item.settling && kind === "count"
                    ? "还在涨，先不比"
                    : item.value !== null && item.typical !== null
                      ? comparisonText(item.value, item.typical, kind) || "—"
                      : "其他篇数不够，没法比"}
                </td>
                <td className="small">
                  {item.standouts.length === 0 ? (
                    <span className="muted">没有明显不同</span>
                  ) : (
                    <ul className="standouts">
                      {item.standouts.map((standout) => (
                        <li key={standout.metric}>{standoutText(standout)}</li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
