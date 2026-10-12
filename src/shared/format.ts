import type { MetricKind } from "./platforms.js";
import type { Standout } from "./schemas.js";

/** A metric value as people read it: "21%" for rates, "7.1 秒" for durations. */
export function formatMetric(value: number, kind: MetricKind): string {
  if (kind === "rate") return `${Math.round(value * 1000) / 10}%`;
  if (kind === "duration") return `${Math.round(value * 10) / 10} 秒`;
  return String(Math.round(value));
}

/** How a value compares with the typical one: "是一般水平的 2.3 倍", "高 9 个百分点". */
export function comparisonText(value: number, typical: number, kind: MetricKind): string {
  if (kind === "rate") {
    const points = Math.round((value - typical) * 1000) / 10;
    return `${points >= 0 ? "高" : "低"} ${Math.abs(points)} 个百分点`;
  }
  if (typical <= 0) return "";
  return `是一般水平的 ${Math.round((value / typical) * 10) / 10} 倍`;
}

/** "封面点击率更高：21%，一般是 12%". */
export function standoutText(standout: Standout): string {
  const direction = standout.value > standout.typical ? "更高" : "更低";
  return `${standout.label}${direction}：${formatMetric(standout.value, standout.kind)}，一般是 ${formatMetric(standout.typical, standout.kind)}`;
}
