import { FlaskConical } from "lucide-react";
import { useEffect, useState } from "react";
import type { PlatformDef } from "../../shared/platforms.js";
import type { ExperimentRecord, ExperimentResult } from "../../shared/schemas.js";
import { experimentOutcomeLabels } from "../../shared/schemas.js";
import { api, type DatasetListItem } from "../api.js";
import { ErrorText, Notice, formatDateTime } from "../components/ui.js";

const statusLabels: Record<ExperimentRecord["status"], string> = {
  running: "进行中",
  finished: "已有结论",
  abandoned: "已放弃",
};

const outcomeClass: Record<ExperimentResult["outcome"], string> = {
  supported: "established",
  not_supported: "buried",
  inconclusive: "questionable",
  waiting: "insufficient",
};

function relativeText(value: number | null, kind: ExperimentResult["effectKind"]): string {
  if (value === null) return "—";
  if (kind === "ratio") {
    const percent = Math.round((value - 1) * 100);
    return `${percent >= 0 ? "+" : ""}${percent}%`;
  }
  return `${value >= 0 ? "+" : ""}${Math.round(value * 10) / 10} 点`;
}

function ResultView({ result }: { result: ExperimentResult }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="row">
        <span className={`verdict ${outcomeClass[result.outcome]}`}>
          {experimentOutcomeLabels[result.outcome]}
        </span>
        <span className="small muted">核对于 {formatDateTime(result.evaluatedAt)}</span>
      </div>
      <p>{result.message}</p>
      {result.known > 0 && (
        <p className="small muted">
          按计划执行：{result.followed} / {result.known} 篇（只统计能从标题或标签判断的）。
        </p>
      )}
      {result.rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">发布时间</th>
                <th scope="col">标题</th>
                <th scope="col">计划</th>
                <th scope="col">实际</th>
                <th scope="col">比同期</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.postId}>
                  <td className="mono small">{row.publishedAt ?? "—"}</td>
                  <td>
                    {row.title}
                    {!row.mature && <div className="small muted">发布不满 7 天，暂不计入</div>}
                  </td>
                  <td className="mono">{row.planned ?? "—"}</td>
                  <td className="mono">
                    {row.actual ?? "—"}
                    {row.assumed && <span className="small muted">（按计划推定）</span>}
                  </td>
                  <td className="num">{relativeText(row.relative, result.effectKind)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ExperimentsPage({ platforms }: { platforms: PlatformDef[] }) {
  const [experiments, setExperiments] = useState<ExperimentRecord[] | null>(null);
  const [datasets, setDatasets] = useState<DatasetListItem[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  function load() {
    Promise.all([api.experiments(), api.datasets()])
      .then(([e, d]) => {
        setExperiments(e.experiments);
        setDatasets(d.datasets.filter((item) => item.confirmed));
      })
      .catch(setError);
  }

  useEffect(load, []);

  async function act(id: string, action: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await action();
      load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  }

  const platformLabel = (id: string) => platforms.find((item) => item.id === id)?.label ?? id;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <h1>实验</h1>
      <p className="muted">
        在报告的“实验处方”里点“开始这个实验”，然后按 A、B
        顺序发内容。发完并且数据稳定后，把最新数据导入并确认，在这里核对。实验是事先定好的单个检验，不需要多重比较校正。
      </p>
      <ErrorText error={error} />
      {experiments === null ? (
        <p className="muted">加载中…</p>
      ) : experiments.length === 0 ? (
        <div className="panel empty">
          <FlaskConical size={22} aria-hidden="true" />
          <p>还没有实验。先做一次解剖，再从报告的实验处方开始。</p>
        </div>
      ) : (
        experiments.map((experiment) => {
          const candidates = datasets.filter((item) => item.platform === experiment.platform);
          const selected = choice[experiment.id] ?? candidates[0]?.id ?? "";
          return (
            <section key={experiment.id} className="panel" aria-label={experiment.hypothesis.claim}>
              <div className="panel-head">
                <h2>{experiment.hypothesis.claim}</h2>
                <span className="chip">{statusLabels[experiment.status]}</span>
              </div>
              <p className="small muted">
                {experiment.accountName} · {platformLabel(experiment.platform)} · 看“
                {experiment.metricLabel}” · {experiment.startedOn} 起发布的内容计入
              </p>
              <div className="schedule" aria-label={`顺序：${experiment.plan.schedule.join("、")}`}>
                {experiment.plan.schedule.map((slot, index) => (
                  <span key={index} className={slot === "A" ? "a" : "b"}>
                    {slot}
                  </span>
                ))}
              </div>
              <p className="small">
                A：{experiment.plan.variantA}
                <br />
                B：{experiment.plan.variantB}
              </p>
              {experiment.result && <ResultView result={experiment.result} />}
              {experiment.status !== "abandoned" && (
                <div className="row">
                  {candidates.length === 0 ? (
                    <Notice kind="info">
                      还没有{platformLabel(experiment.platform)}的已确认数据。先导入最新数据并确认。
                    </Notice>
                  ) : (
                    <>
                      <label className="field" style={{ minWidth: 240 }}>
                        用哪份数据核对
                        <select
                          value={selected}
                          onChange={(event) =>
                            setChoice({ ...choice, [experiment.id]: event.target.value })
                          }
                        >
                          {candidates.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.accountName} · {item.postCount} 条 ·{" "}
                              {formatDateTime(item.createdAt)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="btn primary"
                        disabled={busy !== null || !selected}
                        onClick={() =>
                          act(experiment.id, () => api.checkExperiment(experiment.id, selected))
                        }
                      >
                        核对实验
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="btn"
                    disabled={busy !== null}
                    onClick={() =>
                      act(experiment.id, () => api.setExperimentStatus(experiment.id, "abandoned"))
                    }
                  >
                    放弃这个实验
                  </button>
                </div>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
