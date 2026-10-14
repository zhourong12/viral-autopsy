import type {
  Hypothesis,
  PortDraft,
  PortFlag,
  PortSource,
  PortTarget,
  Post,
} from "../../shared/schemas.js";
import { portTargetLabels } from "../../shared/schemas.js";
import { getFeature } from "../engine/features.js";
import { buildAllowedNumbers, unverifiedNumbers } from "../guards/numberGuard.js";
import type { PortOutput } from "./prompts.js";

/**
 * Checks done in code on every rewrite, so nothing depends on the model having followed its
 * instructions. Editor limits are the commonly cited ones (小红书: title 20, body 1000;
 * 公众号: title 64, digest 120); risky words are experience, not published platform rules.
 */
export const portLimits = {
  xiaohongshuTitle: 20,
  xiaohongshuBody: 1000,
  wechatTitle: 64,
  wechatDigest: 120,
  /** Voice-over longer than this is flagged; Mandarin is read at about 4.5 characters a second. */
  douyinSeconds: 120,
} as const;

const charsPerSecond = 4.5;
const riskyWords = /翻墙|梯子|vpn|科学上网|加微信|微信号|加v|vx|v信|私信领取/gi;
const linkPattern = /https?:\/\/\S+|www\.\S+/i;

function length(text: string): number {
  return Array.from(text).length;
}

/** Numbers the rewrite may use: those in the original and in the creator's own take. */
export function allowedNumbersFor(source: PortSource, myTake: string): Set<string> {
  // Not the URL: a status id's digits would let any number through.
  return buildAllowedNumbers([source.text, myTake, source.author ?? ""]);
}

/** List markers at line starts ("1.", "（2）", "03") are structure, not claims. */
function withoutListMarkers(text: string): string {
  return text.replace(/^\s*(?:\d{1,2}[.、)）]|[（(]\d{1,2}[)）]|0\d(?=\s))\s*/gm, "");
}

export function draftNumbers(draft: PortOutput["drafts"][number], allowed: Set<string>): string[] {
  const text = [...draft.titles, draft.digest ?? "", withoutListMarkers(draft.body)].join("\n");
  return unverifiedNumbers(text, allowed);
}

function displayAuthor(author: string | null): string | null {
  const trimmed = author?.trim();
  if (!trimmed) return null;
  return /^[A-Za-z0-9_]{1,15}$/.test(trimmed) ? `@${trimmed}` : trimmed;
}

/** Attribution in the form each platform tolerates: no link where links are not clickable. */
export function creditLine(platform: PortTarget, source: PortSource): string {
  const who = displayAuthor(source.author);
  const base = who ? `内容来源：X ${who}` : "内容来源：X 上的公开帖子";
  if (platform === "wechat" && source.url) return `${base}，原文链接：${source.url}`;
  return base;
}

/**
 * Whether a title fits an experiment arm (A = with the feature), or null when the claim is not
 * about the title (posting time, cover, labels) and so cannot be checked here.
 */
export function titleFitsArm(
  hypothesis: Hypothesis,
  arm: "A" | "B",
  title: string,
): boolean | null {
  const post: Post = { id: "t", title, publishedAt: null, format: null, metrics: {}, url: null };
  const { spec } = hypothesis;
  if (spec.kind === "keywords") {
    const has = spec.keywords.some((word) => title.toLowerCase().includes(word.toLowerCase()));
    return has === (arm === "A");
  }
  if (spec.kind === "numeric") {
    if (spec.feature !== "titleLength") return null;
    const chars = getFeature("titleLength")?.compute(post, undefined);
    if (typeof chars !== "number") return null;
    return arm === "A" ? chars <= 15 : chars >= 25;
  }
  if (spec.kind !== "feature") return null;
  const def = getFeature(spec.feature);
  if (!def || def.source !== "rule") return null;
  const value = def.compute(post, undefined);
  return typeof value === "boolean" ? value === (arm === "A") : null;
}

export interface DraftContext {
  source: PortSource;
  allowed: Set<string>;
  experiment: {
    hypothesis: Hypothesis;
    arm: "A" | "B";
    variant: string;
    platform: PortTarget;
  } | null;
}

/** Platform editors paste Markdown as literal symbols, so headings and bold markers go. */
export function plainText(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

export function buildDraft(raw: PortOutput["drafts"][number], context: DraftContext): PortDraft {
  const platform = raw.platform;
  const label = portTargetLabels[platform];
  const titles = [...new Set(raw.titles.map((title) => title.trim()).filter(Boolean))];
  const digest = platform === "wechat" ? (raw.digest?.trim() ?? null) : null;
  const body = plainText(raw.body);
  const tags = [...new Set(raw.tags.map((tag) => tag.replace(/^#+/, "").trim()).filter(Boolean))];
  const flags: PortFlag[] = [];

  const numbers = draftNumbers(raw, context.allowed);
  if (numbers.length > 0) {
    flags.push({
      kind: "number",
      text: `出现了原文和你的观点里都没有的数字：${numbers.join("、")}。可能是换算、补充，也可能是 AI 编的，发布前请核实。`,
    });
  }

  const titleLimit =
    platform === "xiaohongshu"
      ? portLimits.xiaohongshuTitle
      : platform === "wechat"
        ? portLimits.wechatTitle
        : null;
  if (titleLimit !== null) {
    for (const title of titles) {
      if (length(title) > titleLimit) {
        flags.push({
          kind: "limit",
          text: `标题“${title}”有 ${length(title)} 字，${label}标题最多 ${titleLimit} 字。`,
        });
      }
    }
  }
  if (platform === "xiaohongshu" && length(body) > portLimits.xiaohongshuBody) {
    flags.push({
      kind: "limit",
      text: `正文 ${length(body)} 字，超过小红书正文 ${portLimits.xiaohongshuBody} 字的上限。`,
    });
  }
  if (digest !== null && length(digest) > portLimits.wechatDigest) {
    flags.push({
      kind: "limit",
      text: `摘要 ${length(digest)} 字，公众号摘要最多 ${portLimits.wechatDigest} 字。`,
    });
  }
  if (platform === "douyin") {
    const seconds = Math.round(length(body.replace(/\s/g, "")) / charsPerSecond);
    if (seconds > portLimits.douyinSeconds) {
      flags.push({ kind: "limit", text: `口播稿读完约 ${seconds} 秒，偏长，建议压到 90 秒左右。` });
    }
  }

  if (platform !== "wechat" && linkPattern.test(body)) {
    flags.push({
      kind: "link",
      text: `正文里有链接：${label}正文的链接一般点不开，还可能被当作站外引流。`,
    });
  }

  const risky = [...new Set([...titles, body, ...tags].join("\n").match(riskyWords) ?? [])];
  if (risky.length > 0) {
    flags.push({
      kind: "wording",
      text: `出现了“${risky.join("”“")}”：这类词在国内平台容易被限流或删除（经验做法，以平台规则为准）。`,
    });
  }

  const { experiment } = context;
  if (experiment && experiment.platform === platform) {
    const results = titles.map((title) => ({
      title,
      fits: titleFitsArm(experiment.hypothesis, experiment.arm, title),
    }));
    if (results.every((item) => item.fits === null)) {
      flags.push({
        kind: "experiment",
        text: `这篇算实验的 ${experiment.arm} 组：${experiment.variant}。这一项没法从标题检查，发布时请自己确认。`,
      });
    }
    for (const item of results) {
      if (item.fits === false) {
        flags.push({
          kind: "experiment",
          text: `标题“${item.title}”不符合实验 ${experiment.arm} 组的要求（${experiment.variant}），用它会打乱实验。`,
        });
      }
    }
  }

  if (!context.source.author?.trim()) {
    flags.push({ kind: "credit", text: "没有填原作者，署名只能写“X 上的公开帖子”，建议补上。" });
  }

  return {
    platform,
    titles,
    digest,
    body,
    tags,
    credit: creditLine(platform, context.source),
    flags,
  };
}
