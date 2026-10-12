import { useEffect, useState } from "react";
import { api, getToken, setToken, type Health } from "../api.js";
import { ErrorText, Notice } from "../components/ui.js";

export function SettingsPage({
  health,
  onTokenSaved,
}: {
  health: Health | null;
  onTokenSaved(): void;
}) {
  const [usage, setUsage] = useState<{
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [token, setTokenValue] = useState(getToken());

  useEffect(() => {
    api
      .usage()
      .then(({ month }) => setUsage(month))
      .catch(setError);
  }, []);

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <h1>设置与用量</h1>
      <ErrorText error={error} />
      <section className="panel" aria-labelledby="ai-title">
        <h2 id="ai-title">AI 状态</h2>
        {health?.ai.configured ? (
          <dl
            className="small"
            style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 16px", margin: 0 }}
          >
            <dt className="muted">截图识别</dt>
            <dd className="mono" style={{ margin: 0 }}>
              {health.ai.models?.vision}
            </dd>
            <dt className="muted">内容标注</dt>
            <dd className="mono" style={{ margin: 0 }}>
              {health.ai.models?.label}
            </dd>
            <dt className="muted">猜想与总结</dt>
            <dd className="mono" style={{ margin: 0 }}>
              {health.ai.models?.reason}
            </dd>
          </dl>
        ) : (
          <Notice kind="warn">
            没有配置 Claude API Key。表格导入、规则检验和实验处方照常可用；截图识别、AI 标注、AI
            猜想和 AI 总结不可用。在服务端的 .env 里设置 ANTHROPIC_API_KEY 后重启即可。
          </Notice>
        )}
        <p className="small muted">
          每个环节默认使用 Claude Opus 5.5，可以用 VA_VISION_MODEL、VA_LABEL_MODEL、VA_REASON_MODEL
          分别换成其他模型。
        </p>
      </section>
      <section className="panel" aria-labelledby="plan-title">
        <h2 id="plan-title">套餐与用量</h2>
        <p>
          当前套餐：
          {health?.plan === "pro"
            ? "Pro（AI 解剖不限次数）"
            : "免费版（每月 1 次 AI 解剖，规则检验不限）"}
          {health?.aiAnalysesLeft !== null &&
            health?.aiAnalysesLeft !== undefined &&
            `，本月还剩 ${health.aiAnalysesLeft} 次`}
        </p>
        {usage && (
          <p className="small muted">
            本月模型调用 {usage.calls} 次，输入 {usage.inputTokens.toLocaleString()} token，输出{" "}
            {usage.outputTokens.toLocaleString()} token，按公开价格估算约 ${usage.costUsd}
            。以账单为准。
          </p>
        )}
      </section>
      <section className="panel" aria-labelledby="token-title">
        <h2 id="token-title">访问令牌</h2>
        <p className="small muted">
          服务端设置了 VA_APP_TOKEN 时才需要填写。令牌只保存在当前标签页。
        </p>
        <div className="row">
          <label className="field" style={{ flex: "1 1 260px" }}>
            访问令牌
            <input
              type="password"
              value={token}
              onChange={(event) => setTokenValue(event.target.value)}
              autoComplete="off"
            />
          </label>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setToken(token.trim());
              onTokenSaved();
            }}
          >
            保存
          </button>
        </div>
      </section>
    </div>
  );
}
