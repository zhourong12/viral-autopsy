import { FlaskConical, ImageUp, Loader2, Sparkles, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PlatformDef } from "../../shared/platforms.js";
import type {
  ColumnAssignment,
  ImportPreview,
  Post,
  PostLabels,
  UploadedFile,
} from "../../shared/schemas.js";
import { api, type DatasetView, type Health } from "../api.js";
import { ColumnMapper } from "../components/ColumnMapper.js";
import { LabelEditor } from "../components/LabelEditor.js";
import { PostTable } from "../components/PostTable.js";
import { SinglePostsPreview } from "../components/SinglePostsPreview.js";
import { ErrorText, Notice, SampleChip } from "../components/ui.js";
import { prepareScreenshots, readAsBase64 } from "../files.js";

type Step = "platform" | "import" | "check" | "labels" | "run";
type ImportTab = "file" | "screenshot" | "paste" | "sample";

const stepNames: Array<[Step, string]> = [
  ["platform", "选平台"],
  ["import", "导入数据"],
  ["check", "核对表格"],
  ["labels", "内容标签"],
  ["run", "开始解剖"],
];

const pathText: Record<string, string> = {
  verified: "已用真实文件核对",
  documented: "有公开资料",
  unverified: "未核实",
  always: "可用",
};

const pathKind: Record<string, string> = {
  export: "后台导出",
  screenshot: "截图识别",
  paste: "粘贴表格",
};

interface Props {
  platforms: PlatformDef[];
  health: Health | null;
  initialDatasetId: string | null;
  onReport(reportId: string): void;
}

export function NewAutopsy({ platforms, health, initialDatasetId, onReport }: Props) {
  const [step, setStep] = useState<Step>("platform");
  const [platformId, setPlatformId] = useState<PlatformDef["id"]>("xiaohongshu");
  const [tab, setTab] = useState<ImportTab>("file");
  const [accountName, setAccountName] = useState("我的账号");
  const [pasteText, setPasteText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dataset, setDataset] = useState<DatasetView | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [labels, setLabels] = useState<Record<string, PostLabels>>({});
  const [metric, setMetric] = useState<string>("");
  const [useAi, setUseAi] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [fileContents, setFileContents] = useState<UploadedFile[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const aiReady = Boolean(health?.ai.configured);
  const platform =
    platforms.find((item) => item.id === (dataset?.platform ?? platformId)) ?? platforms[0];

  function loadDataset(next: DatasetView, nextStep: Step) {
    setDataset(next);
    setPlatformId(next.platform);
    setPosts(next.posts);
    setLabels(next.labels);
    const def = platforms.find((item) => item.id === next.platform);
    setMetric(def?.defaultMetric ?? "views");
    setStep(nextStep);
  }

  useEffect(() => {
    if (!initialDatasetId) return;
    api
      .dataset(initialDatasetId)
      .then(({ dataset: loaded }) => loadDataset(loaded, loaded.confirmed ? "run" : "check"))
      .catch(setError);
    // Only when the requested dataset changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDatasetId]);

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

  function resetPreview() {
    setPreview(null);
    setFileContents(null);
  }

  async function sourceFor(): Promise<
    { kind: "file"; files: UploadedFile[] } | { kind: "paste"; text: string }
  > {
    if (tab === "paste") {
      if (!pasteText.trim()) throw new Error("请先粘贴表格内容。");
      return { kind: "paste", text: pasteText };
    }
    if (files.length === 0) throw new Error("请先选择文件。");
    const contents =
      fileContents ??
      (await Promise.all(
        files.map(async (file) => ({
          fileName: file.name,
          content: await readAsBase64(file),
          encoding: "base64" as const,
        })),
      ));
    setFileContents(contents);
    return { kind: "file", files: contents };
  }

  async function loadPreview(assignment?: ColumnAssignment) {
    const result = await run("正在读取表格…", async () => {
      const source = await sourceFor();
      return (await api.preview({ ...source, platform: platformId, assignment })).preview;
    });
    if (result) setPreview(result);
  }

  async function doImport() {
    const result = await run("正在导入…", async () => {
      if (tab === "sample") return (await api.sample(platformId)).dataset;
      if (tab === "paste" || tab === "file") {
        const source = await sourceFor();
        const assignment = preview?.kind === "table" ? preview.assignment : undefined;
        if (source.kind === "paste") {
          return (
            await api.importPaste({
              platform: platformId,
              accountName,
              text: source.text,
              assignment,
            })
          ).dataset;
        }
        return (
          await api.importFile({
            platform: platformId,
            accountName,
            files: source.files,
            assignment,
          })
        ).dataset;
      }
      if (files.length === 0) throw new Error("请先选择截图。");
      const images = await prepareScreenshots(files);
      if (images.length > 10)
        throw new Error(`截图切分后有 ${images.length} 张，一次最多 10 张，请分批导入。`);
      return (await api.importScreenshots({ platform: platformId, accountName, images })).dataset;
    });
    if (result) loadDataset(result, result.confirmed ? "labels" : "check");
  }

  async function confirmTable() {
    if (!dataset) return;
    const result = await run(
      "正在保存…",
      async () => (await api.confirmPosts(dataset.id, posts)).dataset,
    );
    if (result) loadDataset(result, "labels");
  }

  async function aiLabel() {
    if (!dataset) return;
    const result = await run(
      "AI 正在给内容打标签…",
      async () => (await api.label(dataset.id)).dataset,
    );
    if (result) loadDataset(result, "labels");
  }

  async function saveLabels() {
    if (!dataset) return;
    const result = await run(
      "正在保存标签…",
      async () => (await api.updateLabels(dataset.id, labels)).dataset,
    );
    if (result) loadDataset(result, "run");
  }

  async function analyze() {
    if (!dataset) return;
    const result = await run(
      useAi && aiReady ? "AI 侦探和统计引擎正在解剖…" : "统计引擎正在解剖…",
      async () =>
        (await api.analyze({ datasetId: dataset.id, metric, useAi: useAi && aiReady })).report,
    );
    if (result) onReport(result.id);
  }

  const metricsWithData = useMemo(
    () =>
      (platform?.metrics ?? []).filter((item) =>
        posts.some(
          (post) => post.metrics[item.key] !== null && post.metrics[item.key] !== undefined,
        ),
      ),
    [platform, posts],
  );
  const missingDates = posts.filter((post) => !post.publishedAt).length;
  const uncertainCount = dataset
    ? Object.values(dataset.uncertain).reduce((sum, fields) => sum + fields.length, 0)
    : 0;
  const stepIndex = stepNames.findIndex(([key]) => key === step);

  if (!platform) return <Notice kind="error">平台列表加载失败。</Notice>;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>新的解剖</h1>
        {dataset?.isSample && <SampleChip />}
      </div>
      <ol className="steps" aria-label="步骤">
        {stepNames.map(([key, name], index) => (
          <li
            key={key}
            aria-current={key === step ? "step" : undefined}
            className={index < stepIndex ? "done" : undefined}
          >
            {index + 1}. {name}
          </li>
        ))}
      </ol>

      <ErrorText error={error} />
      {busy && (
        <Notice kind="info">
          <span className="row">
            <Loader2 size={16} className="spin" aria-hidden="true" />
            {busy}
          </span>
        </Notice>
      )}

      {step === "platform" && (
        <section className="panel" aria-labelledby="platform-title">
          <h2 id="platform-title">选择平台</h2>
          <div className="platforms">
            {platforms.map((item) => (
              <button
                key={item.id}
                type="button"
                className="platform-card"
                aria-pressed={item.id === platformId}
                onClick={() => setPlatformId(item.id)}
              >
                <strong>{item.label}</strong>
                <span className="small muted">
                  按{item.contentNoun}分析，默认看“
                  {item.metrics.find((m) => m.key === item.defaultMetric)?.label}”
                </span>
                <span className="paths">
                  {item.importPaths.map((path) => (
                    <span key={path.kind}>
                      {pathKind[path.kind]}：
                      {path.kind === "screenshot" && !aiReady
                        ? "需要配置 AI"
                        : pathText[path.status]}
                    </span>
                  ))}
                </span>
              </button>
            ))}
          </div>
          <div className="row">
            <button type="button" className="btn primary" onClick={() => setStep("import")}>
              下一步
            </button>
          </div>
        </section>
      )}

      {step === "import" && (
        <section className="panel" aria-labelledby="import-title">
          <div className="panel-head">
            <h2 id="import-title">导入{platform.label}数据</h2>
            <button type="button" className="btn" onClick={() => setStep("platform")}>
              换平台
            </button>
          </div>
          <div className="tabs" role="tablist">
            {(
              [
                ["file", "上传表格"],
                ["screenshot", "截图识别"],
                ["paste", "粘贴表格"],
                ["sample", "合成示例"],
              ] as Array<[ImportTab, string]>
            ).map(([key, name]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => {
                  setTab(key);
                  setFiles([]);
                  resetPreview();
                }}
              >
                {name}
              </button>
            ))}
          </div>
          {tab !== "sample" && (
            <label className="field" style={{ maxWidth: 320 }}>
              账号名称
              <input
                value={accountName}
                maxLength={40}
                onChange={(event) => setAccountName(event.target.value)}
              />
            </label>
          )}
          {tab === "file" && (
            <div className="dropzone">
              <Upload size={22} aria-hidden="true" />
              <p>支持 CSV、TSV 和 .xlsx。表格里至少要有标题列和一个数据列。</p>
              <p className="small muted">
                {platform.importPaths.find((path) => path.kind === "export")?.note}
              </p>
              <input
                type="file"
                accept=".csv,.tsv,.txt,.xlsx"
                multiple
                aria-label="选择表格文件"
                onChange={(event) => {
                  setFiles(Array.from(event.target.files ?? []));
                  resetPreview();
                }}
              />
            </div>
          )}
          {tab === "screenshot" && (
            <div className="dropzone">
              <ImageUp size={22} aria-hidden="true" />
              <p>上传数据中心“作品列表”的截图，最多 10 张。长截图会自动切开。</p>
              <p className="small muted">
                截图只用于这一次识别，不会保存；识别结果需要你逐格核对。
              </p>
              {!aiReady && <Notice kind="warn">截图识别需要配置 Claude API Key。</Notice>}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                aria-label="选择截图"
                disabled={!aiReady}
                onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
              />
            </div>
          )}
          {tab === "paste" && (
            <label className="field">
              从表格软件复制（含表头）后粘贴到这里
              <textarea
                value={pasteText}
                onChange={(event) => {
                  setPasteText(event.target.value);
                  resetPreview();
                }}
                placeholder={"标题\t发布时间\t观看\t点赞\n…"}
              />
            </label>
          )}
          {tab === "sample" && (
            <Notice kind="info">
              生成一个{platform.label}的合成账号（60
              篇）。数据里预埋了两条真规律和两个陷阱，用来体验解剖结果；页面会一直标注“合成示例数据”。
            </Notice>
          )}
          {(tab === "file" || tab === "paste") && preview?.kind === "posts" && (
            <SinglePostsPreview preview={preview} platform={platform} />
          )}
          {(tab === "file" || tab === "paste") && preview?.kind === "table" && (
            <section aria-labelledby="mapping-title" style={{ display: "grid", gap: 10 }}>
              <h3 id="mapping-title">列对应</h3>
              <p className="small muted">
                检查每一列被当作什么。真实导出的列名各平台不一样，认不出的列可以在这里手动指定；确认导入后会记住这种表头，下次自动套用。
              </p>
              <ColumnMapper preview={preview} onChange={(assignment) => loadPreview(assignment)} />
            </section>
          )}
          <div className="row">
            {(tab === "file" || tab === "paste") && !preview ? (
              <button
                type="button"
                className="btn primary"
                disabled={Boolean(busy)}
                onClick={() => loadPreview()}
              >
                <Upload size={16} aria-hidden="true" />
                读取表格，核对列
              </button>
            ) : (
              <button
                type="button"
                className="btn primary"
                disabled={Boolean(busy) || (preview?.kind === "table" && !preview.complete)}
                onClick={doImport}
              >
                {tab === "sample" ? (
                  <FlaskConical size={16} aria-hidden="true" />
                ) : (
                  <Upload size={16} aria-hidden="true" />
                )}
                {tab === "sample"
                  ? "生成示例账号"
                  : preview?.kind === "table"
                    ? "按这个对应导入"
                    : "导入"}
              </button>
            )}
          </div>
        </section>
      )}

      {step === "check" && dataset && (
        <section className="panel" aria-labelledby="check-title">
          <div className="panel-head">
            <h2 id="check-title">核对表格（{posts.length} 条）</h2>
            <span className="small muted">黄色格子需要你重点核对</span>
          </div>
          {dataset.importNotes.length > 0 && (
            <Notice kind="info">
              <ul>
                {dataset.importNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </Notice>
          )}
          {uncertainCount > 0 && (
            <Notice kind="warn">有 {uncertainCount} 个格子 AI 没有把握，请对照截图修改。</Notice>
          )}
          {missingDates > 0 && (
            <Notice kind="warn">
              {missingDates} 条缺少发布时间。补齐后才能扣除涨粉影响、检验发布时段。
            </Notice>
          )}
          <PostTable
            platform={platform}
            posts={posts}
            uncertain={dataset.uncertain}
            onChange={setPosts}
          />
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={Boolean(busy) || posts.length === 0}
              onClick={confirmTable}
            >
              数据无误，确认
            </button>
          </div>
        </section>
      )}

      {step === "labels" && dataset && (
        <section className="panel" aria-labelledby="labels-title">
          <div className="panel-head">
            <h2 id="labels-title">内容标签</h2>
            <span className="small muted">
              {dataset.labelSource === "ai"
                ? "当前标签由 AI 标注"
                : dataset.labelSource === "user"
                  ? "当前标签已手动确认"
                  : "还没有标签"}
            </span>
          </div>
          <p className="small muted">
            “教程干货”“封面露脸”这类说法需要标签才能检验。标题里的数字、问句、发布时段等由规则自动识别，不需要标。可以跳过这一步，没有标签的说法会列为“未检验”。
          </p>
          <div className="row">
            <button
              type="button"
              className="btn"
              disabled={!aiReady || Boolean(busy)}
              onClick={aiLabel}
            >
              <Sparkles size={16} aria-hidden="true" />
              AI 自动标注
            </button>
            {!aiReady && <span className="small muted">需要配置 Claude API Key</span>}
          </div>
          <LabelEditor posts={posts} labels={labels} onChange={setLabels} />
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={Boolean(busy)}
              onClick={saveLabels}
            >
              保存标签，下一步
            </button>
            <button type="button" className="btn" onClick={() => setStep("run")}>
              跳过
            </button>
          </div>
        </section>
      )}

      {step === "run" && dataset && (
        <section className="panel" aria-labelledby="run-title">
          <h2 id="run-title">开始解剖</h2>
          <p>
            {dataset.accountName} · {platform.label} · {posts.length} 条{platform.contentNoun}
          </p>
          <label className="field" style={{ maxWidth: 320 }}>
            用哪个指标衡量“火”
            <select value={metric} onChange={(event) => setMetric(event.target.value)}>
              {metricsWithData.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="row small">
            <input
              type="checkbox"
              checked={useAi && aiReady}
              disabled={!aiReady}
              onChange={(event) => setUseAi(event.target.checked)}
            />
            让 AI 侦探再提出针对这个账号的猜想，并写一段总结
            {!aiReady && <span className="muted">（未配置 API Key，只做规则检验）</span>}
          </label>
          {aiReady &&
            health?.aiAnalysesLeft !== null &&
            health?.aiAnalysesLeft !== undefined &&
            !dataset.isSample && (
              <p className="small muted">
                本月还可以做 {health.aiAnalysesLeft} 次 AI 解剖（示例数据不计次）。
              </p>
            )}
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={Boolean(busy)}
              onClick={analyze}
            >
              开始解剖
            </button>
            <button type="button" className="btn" onClick={() => setStep("check")}>
              回去改数据
            </button>
            <button type="button" className="btn" onClick={() => setStep("labels")}>
              改标签
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
