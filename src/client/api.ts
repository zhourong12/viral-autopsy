import type { PlatformDef } from "../shared/platforms.js";
import type { AnalysisReport, Post, PostLabels } from "../shared/schemas.js";

export interface DatasetView {
  id: string;
  platform: PlatformDef["id"];
  accountName: string;
  source: "file" | "screenshot" | "paste" | "sample";
  isSample: boolean;
  confirmed: boolean;
  posts: Post[];
  labels: Record<string, PostLabels>;
  labelSource: "none" | "ai" | "user";
  uncertain: Record<string, string[]>;
  importNotes: string[];
  asOf: string;
  createdAt: string;
}

export interface DatasetListItem {
  id: string;
  platform: PlatformDef["id"];
  accountName: string;
  source: DatasetView["source"];
  isSample: boolean;
  confirmed: boolean;
  createdAt: string;
  postCount: number;
}

export interface AnalysisListItem {
  id: string;
  datasetId: string;
  platform: PlatformDef["id"];
  accountName: string;
  isSample: boolean;
  mode: AnalysisReport["mode"];
  metricLabel: string;
  createdAt: string;
  postsUsed: number;
}

export interface Health {
  ok: boolean;
  ai: { configured: boolean; models: { vision: string; label: string; reason: string } | null };
  plan: string;
  aiAnalysesLeft: number | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const tokenKey = "va-app-token";

export function getToken(): string {
  try {
    return sessionStorage.getItem(tokenKey) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(tokenKey, token);
    else sessionStorage.removeItem(tokenKey);
  } catch {
    // Storage can be unavailable (private mode); the token then lasts for this page only.
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "连不上服务，请确认本地服务还在运行。");
  }
  const data = (await response.json().catch(() => ({}))) as {
    error?: { code: string; message: string };
  };
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data.error?.code ?? "unknown",
      data.error?.message ?? `请求失败（${response.status}）。`,
    );
  }
  return data as T;
}

export const api = {
  health: () => call<Health>("GET", "/api/health"),
  platforms: () => call<{ platforms: PlatformDef[] }>("GET", "/api/platforms"),
  datasets: () => call<{ datasets: DatasetListItem[] }>("GET", "/api/datasets"),
  dataset: (id: string) => call<{ dataset: DatasetView }>("GET", `/api/datasets/${id}`),
  deleteDataset: (id: string) => call<{ deleted: boolean }>("DELETE", `/api/datasets/${id}`),
  importFile: (body: {
    platform: string;
    accountName: string;
    fileName: string;
    content: string;
    encoding: "base64";
  }) => call<{ dataset: DatasetView }>("POST", "/api/datasets/file", body),
  importPaste: (body: { platform: string; accountName: string; text: string }) =>
    call<{ dataset: DatasetView }>("POST", "/api/datasets/paste", body),
  importScreenshots: (body: {
    platform: string;
    accountName: string;
    images: Array<{ mediaType: "image/jpeg"; data: string }>;
  }) => call<{ dataset: DatasetView }>("POST", "/api/datasets/screenshots", body),
  sample: (platform: string) =>
    call<{ dataset: DatasetView }>("POST", "/api/datasets/sample", { platform }),
  confirmPosts: (id: string, posts: Post[]) =>
    call<{ dataset: DatasetView }>("PUT", `/api/datasets/${id}/posts`, { posts }),
  label: (id: string) => call<{ dataset: DatasetView }>("POST", `/api/datasets/${id}/label`),
  updateLabels: (id: string, labels: Record<string, PostLabels>) =>
    call<{ dataset: DatasetView }>("PUT", `/api/datasets/${id}/labels`, { labels }),
  analyze: (body: { datasetId: string; metric?: string; useAi: boolean }) =>
    call<{ report: AnalysisReport }>("POST", "/api/analyses", body),
  analyses: () => call<{ analyses: AnalysisListItem[] }>("GET", "/api/analyses"),
  analysis: (id: string) => call<{ report: AnalysisReport }>("GET", `/api/analyses/${id}`),
  usage: () =>
    call<{ month: { calls: number; inputTokens: number; outputTokens: number; costUsd: number } }>(
      "GET",
      "/api/usage",
    ),
};
