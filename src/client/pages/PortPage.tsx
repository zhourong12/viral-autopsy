import { Check, Copy, ImageUp, Loader2, Repeat2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ExperimentRecord, PortDraft, PortRecord, PortTarget } from "../../shared/schemas.js";
import { portTargetLabels, portTargets } from "../../shared/schemas.js";
import { api, type Health } from "../api.js";
import { ErrorText, Notice, formatDateTime } from "../components/ui.js";
import { prepareScreenshots } from "../files.js";

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      onClick={() =>
        copyText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {done ? "已复制" : label}
    </button>
  );
}

/** The full post as it would be pasted into the platform: body, tags, then the credit. */
function postText(draft: PortDraft): string {
  const tags = draft.tags.length > 0 ? `\n\n${draft.tags.map((tag) => `#${tag}`).join(" ")}` : "";
  return `${draft.body}${tags}\n\n${draft.credit}`;
}

function DraftCard({ draft }: { draft: PortDraft }) {
  return (
    <article className="experiment port-draft" aria-label={portTargetLabels[draft.platform]}>
      <h3>{portTargetLabels[draft.platform]}</h3>
      {draft.flags.length > 0 && (
        <Notice kind="warn">
          <ul>
            {draft.flags.map((flag) => (
              <li key={flag.text}>{flag.text}</li>
            ))}
          </ul>
        </Notice>
      )}
      <div>
        <p className="small muted">标题（选一个）</p>
        <ul className="port-titles">
          {draft.titles.map((title) => (
            <li key={title}>
              <span>{title}</span>
              <CopyButton text={title} />
            </li>
          ))}
        </ul>
      </div>
      {draft.digest && (
        <div>
          <p className="small muted">摘要</p>
          <p>{draft.digest}</p>
          <CopyButton text={draft.digest} label="复制摘要" />
        </div>
      )}
      <div>
        <p className="small muted">{draft.platform === "douyin" ? "口播稿" : "正文"}</p>
        <div className="port-body">{postText(draft)}</div>
      </div>
      <div className="row">
        <CopyButton text={postText(draft)} label="复制正文和署名" />
      </div>
    </article>
  );
}

function ResultView({ port }: { port: PortRecord }) {
  return (
    <section
      className="panel"
      aria-labelledby="port-result-title"
      style={{ display: "grid", gap: 14 }}
    >
      <div className="panel-head">
        <h2 id="port-result-title">改写结果</h2>
        <span className="small muted">{formatDateTime(port.createdAt)}</span>
      </div>
      <p className="summary">{port.summary}</p>
      {port.experiment && (
        <p className="small">
          实验 {port.experiment.arm} 组：{port.experiment.claim}（{port.experiment.variant}）
        </p>
      )}
      {port.warnings.length > 0 && (
        <Notice kind="warn">
          <ul>
            {port.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Notice>
      )}
      {port.checks.length > 0 && (
        <div>
          <h3>发布前要核实</h3>
          <ul className="small">
            {port.checks.map((item) => (
              <li key={item.claim}>
                <strong>{item.claim}</strong>：<span className="muted">{item.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {port.context.length > 0 && (
        <div>
          <h3>国内读者需要的背景</h3>
          <ul className="small">
            {port.context.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="experiments">
        {port.drafts.map((draft) => (
          <DraftCard key={draft.platform} draft={draft} />
        ))}
      </div>
    </section>
  );
}

export function PortPage({ health, onUsed }: { health: Health | null; onUsed(): void }) {
  const [tab, setTab] = useState<"paste" | "screenshot">("paste");
  const [text, setText] = useState("");
  const [author, setAuthor] = useState("");
  const [url, setUrl] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [transcribed, setTranscribed] = useState<{ notes: string[]; uncertain: string[] } | null>(
    null,
  );
  const [targets, setTargets] = useState<PortTarget[]>(["xiaohongshu"]);
  const [myTake, setMyTake] = useState("");
  const [experiments, setExperiments] = useState<ExperimentRecord[]>([]);
  const [experimentChoice, setExperimentChoice] = useState("");
  const [result, setResult] = useState<PortRecord | null>(null);
  const [history, setHistory] = useState<PortRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const aiReady = Boolean(health?.ai.configured);

  function loadLists() {
    Promise.all([api.ports(), api.experiments()])
      .then(([ports, list]) => {
        setHistory(ports.ports);
        setExperiments(
          list.experiments.filter(
            (item) =>
              item.status === "running" &&
              (portTargets as readonly string[]).includes(item.platform),
          ),
        );
      })
      .catch(setError);
  }

  useEffect(loadLists, []);

  async function run<T>(label: string, action: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError(null);
    try {
      return await action();
    } catch (caught) {
      setError(caught);
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function transcribe() {
    const transcript = await run("正在识别截图里的文字…", async () => {
      const images = await prepareScreenshots(files);
      if (images.length > 6) throw new Error(`截图切分后有 ${images.length} 张，一次最多 6 张。`);
      return (await api.transcribePort(images)).transcript;
    });
    if (!transcript) return;
    setText(transcript.text);
    if (transcript.author) setAuthor(transcript.author);
    setTranscribed({ notes: transcript.notes, uncertain: transcript.uncertain });
    setTab("paste");
  }

  async function generate() {
    const [id, arm] = experimentChoice.split(":");
    const port = await run(
      "正在改写…",
      async () =>
        (
          await api.createPort({
            source: { text, author: author.trim() || null, url: url.trim() || null },
            targets,
            myTake,
            experiment: id && (arm === "A" || arm === "B") ? { id, arm } : null,
          })
        ).port,
    );
    if (!port) return;
    setResult(port);
    loadLists();
    onUsed();
  }

  async function remove(id: string) {
    await run("正在删除…", () => api.deletePort(id));
    if (result?.id === id) setResult(null);
    loadLists();
  }

  const usable = experiments.filter((item) => targets.includes(item.platform as PortTarget));

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <h1>X 搬运</h1>
      <p className="muted">
        把 X 上的 AI 内容改写成小红书、公众号和抖音的版本。AI
        负责重写和找出要核实的说法；原文没有的数字、平台字数、链接和敏感词由代码逐条检查；署名自动附上。加上你自己的观点，它才不只是翻译。
      </p>
      {!aiReady && <Notice kind="warn">需要配置 Claude API Key 才能用 X 搬运。</Notice>}
      {aiReady && health?.portsLeft !== null && health?.portsLeft !== undefined && (
        <p className="small muted">免费版本月还可以搬运 {health.portsLeft} 次。</p>
      )}
      <ErrorText error={error} />
      {busy && (
        <Notice kind="info">
          <span className="row">
            <Loader2 size={16} className="spin" aria-hidden="true" />
            {busy}
          </span>
        </Notice>
      )}

      <section
        className="panel"
        aria-labelledby="port-source-title"
        style={{ display: "grid", gap: 12 }}
      >
        <h2 id="port-source-title">原文</h2>
        <div className="tabs" role="tablist">
          {(
            [
              ["paste", "粘贴原文"],
              ["screenshot", "截图识别"],
            ] as const
          ).map(([key, name]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
            >
              {name}
            </button>
          ))}
        </div>
        {tab === "screenshot" ? (
          <div className="dropzone">
            <ImageUp size={22} aria-hidden="true" />
            <p>
              上传 X 帖子的截图，最多 6
              张，长截图会自动切开。识别出的文字会放进原文框，请对照截图核对。
            </p>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              aria-label="选择帖子截图"
              disabled={!aiReady}
              onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
            />
            <button
              type="button"
              className="btn primary"
              disabled={!aiReady || busy !== null || files.length === 0}
              onClick={transcribe}
            >
              识别文字
            </button>
          </div>
        ) : (
          <>
            {transcribed && (
              <Notice kind="info">
                已从截图识别出文字，请对照截图核对后再改写。
                {transcribed.uncertain.length > 0 &&
                  ` 看不清的地方：${transcribed.uncertain.join("、")}。`}
                {transcribed.notes.length > 0 && ` ${transcribed.notes.join(" ")}`}
              </Notice>
            )}
            <label className="field">
              原文（一条帖子或整串推文）
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="把帖子正文粘贴到这里"
              />
            </label>
            <div className="row">
              <label className="field" style={{ flex: "1 1 200px" }}>
                原作者（用于署名）
                <input
                  value={author}
                  maxLength={80}
                  onChange={(event) => setAuthor(event.target.value)}
                  placeholder="比如 @alice_ai"
                />
              </label>
              <label className="field" style={{ flex: "2 1 280px" }}>
                原帖链接（可选，公众号署名里会带上）
                <input
                  value={url}
                  maxLength={500}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://x.com/…"
                />
              </label>
            </div>
          </>
        )}
      </section>

      <section
        className="panel"
        aria-labelledby="port-rewrite-title"
        style={{ display: "grid", gap: 12 }}
      >
        <h2 id="port-rewrite-title">改写</h2>
        <fieldset className="row" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small muted" style={{ marginBottom: 6 }}>
            写成哪些平台的版本
          </legend>
          {portTargets.map((target) => (
            <label key={target} className="row small">
              <input
                type="checkbox"
                checked={targets.includes(target)}
                onChange={(event) =>
                  setTargets(
                    event.target.checked
                      ? portTargets.filter((item) => item === target || targets.includes(item))
                      : targets.filter((item) => item !== target),
                  )
                }
              />
              {portTargetLabels[target]}
            </label>
          ))}
        </fieldset>
        <label className="field">
          你的观点（建议写）
          <textarea
            value={myTake}
            maxLength={3000}
            style={{ minHeight: 90, fontFamily: "inherit", fontSize: 14 }}
            onChange={(event) => setMyTake(event.target.value)}
            placeholder="你的实测、看法或补充。比如：我用它重写了一个小项目，速度确实快，但中文回答偶尔夹英文。"
          />
        </label>
        {usable.length > 0 && (
          <label className="field" style={{ maxWidth: 520 }}>
            这篇算进实验吗
            <select
              value={experimentChoice}
              onChange={(event) => setExperimentChoice(event.target.value)}
            >
              <option value="">不算</option>
              {usable.flatMap((item) =>
                (["A", "B"] as const).map((arm) => (
                  <option key={`${item.id}:${arm}`} value={`${item.id}:${arm}`}>
                    {portTargetLabels[item.platform as PortTarget]} · {item.hypothesis.claim} ·{" "}
                    {arm} 组（
                    {arm === "A" ? item.plan.variantA : item.plan.variantB}）
                  </option>
                )),
              )}
            </select>
          </label>
        )}
        <div className="row">
          <button
            type="button"
            className="btn primary"
            disabled={!aiReady || busy !== null || !text.trim() || targets.length === 0}
            onClick={generate}
          >
            <Repeat2 size={16} aria-hidden="true" />
            改写
          </button>
        </div>
      </section>

      {result && <ResultView port={result} />}

      {history.length > 0 && (
        <section className="panel" aria-labelledby="port-history-title">
          <h2 id="port-history-title">搬运记录</h2>
          <div className="list">
            {history.map((item) => (
              <div key={item.id} className="list-item">
                <div>
                  <strong>{item.summary || item.source.text.slice(0, 40)}</strong>
                  <div className="small muted">
                    {formatDateTime(item.createdAt)} ·{" "}
                    {item.drafts.map((draft) => portTargetLabels[draft.platform]).join("、")}
                    {item.source.author && ` · ${item.source.author}`}
                  </div>
                </div>
                <div className="row">
                  <button type="button" className="btn" onClick={() => setResult(item)}>
                    查看
                  </button>
                  <button
                    type="button"
                    className="btn"
                    aria-label="删除这条搬运记录"
                    onClick={() => remove(item.id)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
