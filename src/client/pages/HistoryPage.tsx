import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { PlatformDef } from "../../shared/platforms.js";
import { api, type AnalysisListItem, type DatasetListItem } from "../api.js";
import { ErrorText, SampleChip, formatDateTime } from "../components/ui.js";

interface Props {
  platforms: PlatformDef[];
  onOpenReport(id: string): void;
  onOpenDataset(id: string): void;
}

export function HistoryPage({ platforms, onOpenReport, onOpenDataset }: Props) {
  const [analyses, setAnalyses] = useState<AnalysisListItem[] | null>(null);
  const [datasets, setDatasets] = useState<DatasetListItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  function load() {
    Promise.all([api.analyses(), api.datasets()])
      .then(([a, d]) => {
        setAnalyses(a.analyses);
        setDatasets(d.datasets);
      })
      .catch(setError);
  }

  useEffect(load, []);

  const platformLabel = (id: string) => platforms.find((item) => item.id === id)?.label ?? id;

  async function remove(id: string) {
    try {
      await api.deleteDataset(id);
      setConfirmDelete(null);
      load();
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <h1>报告与数据</h1>
      <ErrorText error={error} />
      <section className="panel" aria-labelledby="reports-title">
        <h2 id="reports-title">解剖报告</h2>
        {analyses === null ? (
          <p className="muted">加载中…</p>
        ) : analyses.length === 0 ? (
          <p className="empty">还没有报告。先去做一次解剖吧。</p>
        ) : (
          <div className="list">
            {analyses.map((item) => (
              <div key={item.id} className="list-item">
                <div>
                  <strong>{item.accountName}</strong>
                  <div className="small muted row">
                    {item.isSample && <SampleChip />}
                    <span>{platformLabel(item.platform)}</span>
                    <span>{item.mode === "ai" ? "AI + 统计" : "仅规则"}</span>
                    <span>看“{item.metricLabel}”</span>
                    <span>{item.postsUsed} 篇</span>
                    <span>{formatDateTime(item.createdAt)}</span>
                  </div>
                </div>
                <button type="button" className="btn" onClick={() => onOpenReport(item.id)}>
                  查看报告
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="panel" aria-labelledby="datasets-title">
        <h2 id="datasets-title">导入的数据</h2>
        <p className="small muted">
          删除数据会同时删除基于它的报告。截图从不保存，这里只有识别后的数字。
        </p>
        {datasets === null ? (
          <p className="muted">加载中…</p>
        ) : datasets.length === 0 ? (
          <p className="empty">还没有导入数据。</p>
        ) : (
          <div className="list">
            {datasets.map((item) => (
              <div key={item.id} className="list-item">
                <div>
                  <strong>{item.accountName}</strong>
                  <div className="small muted row">
                    {item.isSample && <SampleChip />}
                    <span>{platformLabel(item.platform)}</span>
                    <span>{item.postCount} 条</span>
                    <span>{item.confirmed ? "已确认" : "待核对"}</span>
                    <span>{formatDateTime(item.createdAt)}</span>
                  </div>
                </div>
                <div className="row">
                  <button type="button" className="btn" onClick={() => onOpenDataset(item.id)}>
                    {item.confirmed ? "再解剖一次" : "继续核对"}
                  </button>
                  {confirmDelete === item.id ? (
                    <>
                      <button type="button" className="btn danger" onClick={() => remove(item.id)}>
                        确认删除
                      </button>
                      <button type="button" className="btn" onClick={() => setConfirmDelete(null)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn danger"
                      aria-label={`删除 ${item.accountName}`}
                      onClick={() => setConfirmDelete(item.id)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
