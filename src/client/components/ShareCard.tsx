import { Download } from "lucide-react";
import { useRef } from "react";
import type { AnalysisReport } from "../../shared/schemas.js";
import { causeLabels } from "../../shared/schemas.js";

const width = 1080;
const height = 1350;

function wrap(text: string, perLine: number, maxLines: number): string[] {
  const chars = Array.from(text);
  const lines: string[] = [];
  for (let i = 0; i < chars.length && lines.length < maxLines; i += perLine) {
    lines.push(chars.slice(i, i + perLine).join(""));
  }
  if (chars.length > perLine * maxLines && lines.length > 0) {
    lines[lines.length - 1] = `${(lines[lines.length - 1] ?? "").slice(0, -1)}…`;
  }
  return lines;
}

/** A shareable "体检单" image. Only the engine's verdicts appear on it, no AI prose. */
export function ShareCard({ report }: { report: AnalysisReport }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const myths = report.findings.filter((finding) => finding.hypothesis.origin === "myth");
  const judged = myths.filter((finding) => finding.verdict !== "insufficient");
  const buried = myths.filter((finding) => finding.verdict === "buried");
  const established = report.findings
    .filter((finding) => finding.verdict === "established")
    .slice(0, 2);
  const graves = buried.slice(0, 3);
  const headline =
    judged.length > 0
      ? `检验了 ${myths.length} 条爆款说法，${buried.length} 条在我自己的数据里不成立`
      : `检验了 ${myths.length} 条爆款说法，样本还不够下结论`;

  async function download() {
    const svg = svgRef.current;
    if (!svg) return;
    const source = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml;charset=utf-8" }));
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
      const link = document.createElement("a");
      link.download = `爆款解剖-${report.accountName}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    };
    image.src = url;
  }

  const font = "'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif";
  const serif = "'Noto Serif SC','Songti SC','SimSun',serif";
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="share-preview">
        <svg
          ref={svgRef}
          xmlns="http://www.w3.org/2000/svg"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`分享卡：${headline}`}
        >
          <rect width={width} height={height} fill="#f4f6f5" />
          <rect
            x="60"
            y="60"
            width={width - 120}
            height={height - 120}
            rx="24"
            fill="#ffffff"
            stroke="#c9d2cd"
            strokeWidth="3"
          />
          <text x="110" y="170" fontFamily={serif} fontSize="64" fontWeight="800" fill="#142019">
            玄学体检单
          </text>
          <text x="110" y="230" fontFamily={font} fontSize="30" fill="#5f6d65">
            {report.accountName} · {report.postsUsed} 篇 · 看“{report.metricLabel}”
          </text>
          {report.isSample && (
            <text x="110" y="276" fontFamily={font} fontSize="28" fill="#8a5300">
              合成示例数据
            </text>
          )}
          {wrap(headline, 15, 3).map((line, index) => (
            <text
              key={line}
              x="110"
              y={360 + index * 64}
              fontFamily={serif}
              fontSize="50"
              fontWeight="800"
              fill="#0b6e5a"
            >
              {line}
            </text>
          ))}
          <text x="110" y="590" fontFamily={font} fontSize="30" fill="#5f6d65">
            经得起检验的
          </text>
          {established.length === 0 && (
            <text x="110" y="645" fontFamily={font} fontSize="34" fill="#142019">
              暂时没有，需要更多数据
            </text>
          )}
          {established.map((finding, index) => (
            <text
              key={finding.hypothesis.id}
              x="110"
              y={645 + index * 56}
              fontFamily={font}
              fontSize="36"
              fill="#0b6e2f"
            >
              ✓ {wrap(finding.hypothesis.claim, 22, 1)[0]}
            </text>
          ))}
          <text x="110" y="800" fontFamily={font} fontSize="30" fill="#5f6d65">
            玄学墓地
          </text>
          {graves.map((finding, index) => {
            const x = 110 + index * 290;
            return (
              <g key={finding.hypothesis.id}>
                <path
                  d={`M ${x} 1110 L ${x} 900 Q ${x} 830 ${x + 130} 830 Q ${x + 260} 830 ${x + 260} 900 L ${x + 260} 1110 Z`}
                  fill="#e6eae7"
                />
                <text
                  x={x + 130}
                  y="890"
                  textAnchor="middle"
                  fontFamily={serif}
                  fontSize="22"
                  fill="#5f6d65"
                  letterSpacing="6"
                >
                  R.I.P.
                </text>
                {wrap(finding.hypothesis.claim, 8, 3).map((line, lineIndex) => (
                  <text
                    key={line}
                    x={x + 130}
                    y={950 + lineIndex * 38}
                    textAnchor="middle"
                    fontFamily={font}
                    fontSize="30"
                    fontWeight="700"
                    fill="#142019"
                  >
                    {line}
                  </text>
                ))}
                {finding.cause &&
                  wrap(causeLabels[finding.cause], 9, 2).map((line, lineIndex) => (
                    <text
                      key={line}
                      x={x + 130}
                      y={1060 + lineIndex * 30}
                      textAnchor="middle"
                      fontFamily={font}
                      fontSize="22"
                      fill="#44524a"
                    >
                      {line}
                    </text>
                  ))}
              </g>
            );
          })}
          {graves.length === 0 && (
            <text x="110" y="870" fontFamily={font} fontSize="34" fill="#142019">
              这次没有埋掉的说法
            </text>
          )}
          <text x="110" y="1200" fontFamily={font} fontSize="26" fill="#5f6d65">
            统计检验判真假，不是 AI 拍脑袋 · 爆款解剖室
          </text>
        </svg>
      </div>
      <div>
        <button type="button" className="btn" onClick={download}>
          <Download size={16} aria-hidden="true" />
          下载分享图
        </button>
      </div>
    </div>
  );
}
