import { Microscope } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { PlatformDef } from "../shared/platforms.js";
import { api, type Health } from "./api.js";
import { ErrorText } from "./components/ui.js";
import { ExperimentsPage } from "./pages/ExperimentsPage.js";
import { HistoryPage } from "./pages/HistoryPage.js";
import { NewAutopsy } from "./pages/NewAutopsy.js";
import { ReportPage } from "./pages/ReportPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

type View =
  | { name: "new"; datasetId: string | null; key: number }
  | { name: "history" }
  | { name: "report"; reportId: string }
  | { name: "experiments" }
  | { name: "settings" };

export function App() {
  const [view, setView] = useState<View>({ name: "new", datasetId: null, key: 0 });
  const [platforms, setPlatforms] = useState<PlatformDef[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(() => {
    setError(null);
    Promise.all([api.health(), api.platforms()])
      .then(([h, p]) => {
        setHealth(h);
        setPlatforms(p.platforms);
      })
      .catch(setError);
  }, []);

  useEffect(refresh, [refresh]);

  const nav: Array<[View["name"], string]> = [
    ["new", "新的解剖"],
    ["history", "报告与数据"],
    ["experiments", "实验"],
    ["settings", "设置"],
  ];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Microscope size={22} aria-hidden="true" color="var(--accent)" />
          <strong>爆款解剖室</strong>
          <span className="small muted">AI 提猜想，统计当法官</span>
        </div>
        <nav className="nav" aria-label="主导航">
          {nav.map(([name, label]) => (
            <button
              key={name}
              type="button"
              aria-current={
                view.name === name || (name === "history" && view.name === "report")
                  ? "page"
                  : undefined
              }
              onClick={() => {
                if (name === "new") setView({ name: "new", datasetId: null, key: Date.now() });
                else if (name === "history") setView({ name: "history" });
                else if (name === "experiments") setView({ name: "experiments" });
                else setView({ name: "settings" });
                refresh();
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <span className="status-pill">
          {health ? (health.ai.configured ? "AI 已启用" : "未配置 AI，仅规则检验") : "连接中…"}
        </span>
      </header>
      <main className="content">
        <ErrorText error={error} />
        {view.name === "new" && platforms.length > 0 && (
          <NewAutopsy
            key={view.key}
            platforms={platforms}
            health={health}
            initialDatasetId={view.datasetId}
            onReport={(reportId) => {
              refresh();
              setView({ name: "report", reportId });
            }}
          />
        )}
        {view.name === "history" && (
          <HistoryPage
            platforms={platforms}
            onOpenReport={(reportId) => setView({ name: "report", reportId })}
            onOpenDataset={(datasetId) => setView({ name: "new", datasetId, key: Date.now() })}
          />
        )}
        {view.name === "report" && (
          <ReportPage
            platforms={platforms}
            reportId={view.reportId}
            onBack={() => setView({ name: "history" })}
            onOpenExperiments={() => setView({ name: "experiments" })}
          />
        )}
        {view.name === "experiments" && <ExperimentsPage platforms={platforms} />}
        {view.name === "settings" && <SettingsPage health={health} onTokenSaved={refresh} />}
      </main>
    </div>
  );
}
