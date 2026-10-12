import { AlertTriangle, CheckCircle2, CircleHelp, Info, Skull, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { Verdict } from "../../shared/schemas.js";
import { verdictLabels } from "../../shared/schemas.js";

export function Notice({
  kind,
  children,
}: {
  kind: "info" | "warn" | "error";
  children: ReactNode;
}) {
  const Icon = kind === "error" ? XCircle : kind === "warn" ? AlertTriangle : Info;
  return (
    <div className={`notice ${kind}`} role={kind === "error" ? "alert" : "status"}>
      <Icon size={18} aria-hidden="true" style={{ flex: "none", marginTop: 2 }} />
      <div>{children}</div>
    </div>
  );
}

const verdictIcons: Record<Verdict, typeof CheckCircle2> = {
  established: CheckCircle2,
  questionable: CircleHelp,
  insufficient: Info,
  buried: Skull,
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const Icon = verdictIcons[verdict];
  return (
    <span className={`verdict ${verdict}`}>
      <Icon size={14} aria-hidden="true" />
      {verdictLabels[verdict]}
    </span>
  );
}

export function SampleChip() {
  return <span className="chip sample">合成示例数据</span>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <Notice kind="error">{message}</Notice>;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { hour12: false });
}
