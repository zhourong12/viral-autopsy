import { CheckCircle2, CircleSlash, MinusCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { AnalysisReport, Finding, TestOutcome } from "../../shared/schemas.js";
import { causeLabels, doubtLabels } from "../../shared/schemas.js";
import { api } from "../api.js";
import { ShareCard } from "../components/ShareCard.js";
import { ErrorText, Notice, SampleChip, VerdictBadge, formatDateTime } from "../components/ui.js";

function effectText(test: TestOutcome): string {
  if (test.effect === null) return "—";
  if (test.effectKind === "ratio") {
    const percent = Math.round((test.effect - 1) * 100);
    return `${percent >= 0 ? "+" : ""}${percent}%`;
  }
  if (test.effectKind === "points")
    return `${test.effect >= 0 ? "+" : ""}${Math.round(test.effect * 10) / 10} 个百分点`;
  return `ρ = ${test.effect.toFixed(2)}`;
}

function pText(value: number | null): string {
  if (value === null) return "—";
  if (value < 0.001) return "<0.001";
  return value < 0.01 ? value.toFixed(3) : value.toFixed(2);
}

function reasonText(finding: Finding): string | null {
  if (finding.cause) return `死因：${causeLabels[finding.cause]}`;
  if (finding.doubt) return doubtLabels[finding.doubt];
  return null;
}

function FindingRows({
  findings,
  alternatives,
}: {
  findings: Finding[];
  alternatives: Map<string, string>;
}) {
  return (
    <div className="table-wrap findings">
      <table>
        <thead>
          <tr>
            <th scope="col">说法</th>
            <th scope="col">结果</th>
            <th scope="col">依据</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((finding) => {
            const reason = reasonText(finding);
            const alternative = alternatives.get(finding.hypothesis.id);
            return (
              <tr key={finding.hypothesis.id} className="finding-row">
                <td>
                  <strong>{finding.hypothesis.claim}</strong>
                  {finding.hypothesis.rationale && (
                    <div className="small muted">AI 的理由：{finding.hypothesis.rationale}</div>
                  )}
                </td>
                <td>
                  <VerdictBadge verdict={finding.verdict} />
                  {reason && (
                    <div className="small muted" style={{ marginTop: 4 }}>
                      {reason}
                    </div>
                  )}
                </td>
                <td className="evidence">
                  <p>{finding.evidence}</p>
                  {alternative && <p className="alt">反方意见：{alternative}</p>}
                  <details className="how">
                    <summary>怎么算的</summary>
                    <dl>
                      <dt>两组篇数</dt>
                      <dd className="mono">
                        {finding.test.effectKind === "correlation"
                          ? `${finding.test.nWith} 篇`
                          : `${finding.test.nWith} / ${finding.test.nWithout}`}
                      </dd>
                      {finding.test.medianWith !== null && (
                        <>
                          <dt>中位数</dt>
                          <dd className="mono">
                            {Math.round(finding.test.medianWith)} /{" "}
                            {finding.test.medianWithout === null
                              ? "—"
                              : Math.round(finding.test.medianWithout)}
                          </dd>
                        </>
                      )}
                      <dt>扣除同期后的差异</dt>
                      <dd className="mono">{effectText(finding.test)}</dd>
                      <dt>p / 校正后 q</dt>
                      <dd className="mono">
                        {pText(finding.test.pValue)} / {pText(finding.test.qValue)}
                      </dd>
                      {finding.neededPerGroup !== null && (
                        <>
                          <dt>大约需要</dt>
                          <dd>每组 {finding.neededPerGroup} 篇</dd>
                        </>
                      )}
                    </dl>
                    {finding.checks.map((check) => (
                      <div key={check.name} className="check">
                        {check.passed === true ? (
                          <CheckCircle2 size={14} aria-label="通过" color="var(--ok)" />
                        ) : check.passed === false ? (
                          <CircleSlash size={14} aria-label="未通过" color="var(--bad)" />
                        ) : (
                          <MinusCircle size={14} aria-label="仅供参考" color="var(--muted)" />
                        )}
                        <span>
                          {check.label}：{check.detail}
                        </span>
                      </div>
                    ))}
                  </details>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const verdictOrder: Record<Finding["verdict"], number> = {
  established: 0,
  questionable: 1,
  buried: 2,
  insufficient: 3,
};

export function ReportPage({ reportId, onBack }: { reportId: string; onBack(): void }) {
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setReport(null);
    api
      .analysis(reportId)
      .then(({ report: loaded }) => setReport(loaded))
      .catch(setError);
  }, [reportId]);

  if (error) return <ErrorText error={error} />;
  if (!report) return <p className="muted">正在读取报告…</p>;

  const sorted = report.findings
    .slice()
    .sort((a, b) => verdictOrder[a.verdict] - verdictOrder[b.verdict]);
  const myths = sorted.filter((finding) => finding.hypothesis.origin === "myth");
  const aiFindings = sorted.filter((finding) => finding.hypothesis.origin === "ai");
  const buried = report.findings.filter((finding) => finding.verdict === "buried");
  const alternatives = new Map(report.alternatives.map((item) => [item.hypothesisId, item.text]));
  const count = (verdict: Finding["verdict"]) =>
    report.findings.filter((finding) => finding.verdict === verdict).length;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div className="report-head">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h1>解剖报告 · {report.accountName}</h1>
          <button type="button" className="btn" onClick={onBack}>
            返回列表
          </button>
        </div>
        <div className="row small muted">
          {report.isSample && <SampleChip />}
          <span className={`chip${report.mode === "ai" ? " ai" : ""}`}>
            {report.mode === "ai" ? "AI + 统计引擎" : "仅规则检验（未使用 AI）"}
          </span>
          <span>指标：{report.metricLabel}</span>
          <span>使用 {report.postsUsed} 篇</span>
          <span>{formatDateTime(report.createdAt)}</span>
        </div>
      </div>

      {[...report.exclusionNotes, ...report.warnings].length > 0 && (
        <Notice kind="warn">
          <ul>
            {[...report.exclusionNotes, ...report.warnings].map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Notice>
      )}

      <section className="panel" aria-labelledby="summary-title">
        <div className="panel-head">
          <h2 id="summary-title">结论</h2>
          <span className="small muted">
            {report.summarySource === "ai" ? "AI 撰写，数字已逐个核对" : "引擎自动生成"}
          </span>
        </div>
        <p className="summary">{report.summary}</p>
        <div className="tally">
          <div className="ok">
            <span className="value">{count("established")}</span>成立
          </div>
          <div className="warn">
            <span className="value">{count("questionable")}</span>存疑
          </div>
          <div className="none">
            <span className="value">{count("insufficient")}</span>证据不足
          </div>
          <div className="bad">
            <span className="value">{count("buried")}</span>不成立
          </div>
        </div>
      </section>

      <section className="panel" aria-labelledby="myth-title">
        <h2 id="myth-title">玄学体检单</h2>
        <p className="small muted">
          20 条圈内流传的说法，逐条用你自己的数据检验。“扣除同期”指和前后各 5
          篇相比，去掉账号涨粉带来的影响。
        </p>
        <FindingRows findings={myths} alternatives={alternatives} />
      </section>

      {aiFindings.length > 0 && (
        <section className="panel" aria-labelledby="ai-title">
          <h2 id="ai-title">AI 侦探的猜想</h2>
          <p className="small muted">AI 根据你的标题提出，由同一个引擎检验、一起做多重比较校正。</p>
          <FindingRows findings={aiFindings} alternatives={alternatives} />
        </section>
      )}

      {buried.length > 0 && (
        <section className="panel" aria-labelledby="grave-title">
          <h2 id="grave-title">玄学墓地</h2>
          <div className="graveyard">
            {buried.map((finding) => (
              <div key={finding.hypothesis.id} className="stone">
                <span className="rip">R.I.P.</span>
                <span className="claim">{finding.hypothesis.claim}</span>
                {finding.cause && <span className="cause">死因：{causeLabels[finding.cause]}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {report.experiments.length > 0 && (
        <section className="panel" aria-labelledby="exp-title">
          <h2 id="exp-title">实验处方</h2>
          <p className="small muted">
            有苗头但证据不够的说法，用接下来几篇交替验证。A、B 按 ABBA 交错，抵消账号涨跌的影响。
          </p>
          <div className="experiments">
            {report.experiments.map((plan) => (
              <article key={plan.hypothesisId} className="experiment">
                <h3>{plan.claim}</h3>
                <div className="schedule" aria-label={`顺序：${plan.schedule.join("、")}`}>
                  {plan.schedule.map((slot, index) => (
                    <span key={index} className={slot === "A" ? "a" : "b"}>
                      {slot}
                    </span>
                  ))}
                </div>
                <p className="small">
                  A：{plan.variantA}
                  <br />
                  B：{plan.variantB}
                </p>
                <ol>
                  {plan.instructions.slice(1).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ol>
              </article>
            ))}
          </div>
        </section>
      )}

      {report.untested.length > 0 && (
        <section className="panel" aria-labelledby="untested-title">
          <h2 id="untested-title">这次没法检验的</h2>
          <ul className="small">
            {report.untested.map((item) => (
              <li key={item.claim}>
                {item.claim}：<span className="muted">{item.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel" aria-labelledby="share-title">
        <h2 id="share-title">分享卡</h2>
        <ShareCard report={report} />
      </section>
    </div>
  );
}
