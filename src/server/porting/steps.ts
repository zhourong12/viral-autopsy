import type { PortSource, PortTarget, UsageSummary } from "../../shared/schemas.js";
import { portTargetLabels } from "../../shared/schemas.js";
import type { StructuredLlm } from "../ai/llm.js";
import type { ScreenshotImage } from "../ai/steps.js";
import { draftNumbers } from "./checks.js";
import {
  PortOutputSchema,
  TranscriptSchema,
  portSystemPrompt,
  transcribeSystemPrompt,
  type PortOutput,
} from "./prompts.js";

function escapeXml(text: string): string {
  return text.replace(/[<>&"]/g, (char) =>
    char === "<" ? "&lt;" : char === ">" ? "&gt;" : char === '"' ? "&quot;" : "&amp;",
  );
}

export interface Transcript {
  text: string;
  author: string | null;
  notes: string[];
  uncertain: string[];
  usage: UsageSummary[];
}

/**
 * Screenshots of X posts to plain text, in order. Posts repeated across overlapping
 * screenshots are kept once. The user edits the text before it is rewritten.
 */
export async function transcribePosts(
  llm: StructuredLlm,
  images: ScreenshotImage[],
): Promise<Transcript> {
  const results = await Promise.all(
    images.map((image, index) =>
      llm.generate({
        stage: "vision",
        label: `port-transcribe-${index + 1}`,
        system: transcribeSystemPrompt,
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: image.mediaType, data: image.data },
          },
          { type: "text", text: `这是第 ${index + 1} 张截图，共 ${images.length} 张。` },
        ],
        schema: TranscriptSchema,
        maxTokens: 8000,
      }),
    ),
  );
  const seen = new Set<string>();
  const blocks: string[] = [];
  let author: string | null = null;
  const notes: string[] = [];
  const uncertain: string[] = [];
  for (const { data } of results) {
    notes.push(...data.notes);
    uncertain.push(...data.uncertain);
    for (const post of data.posts) {
      const text = post.text.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      author ??= post.handle?.trim() || post.author?.trim() || null;
      blocks.push(post.quoted?.trim() ? `${text}\n\n（引用的帖子）${post.quoted.trim()}` : text);
    }
  }
  if (blocks.length === 0) notes.push("截图里没有认出 X 帖子的文字。");
  return {
    text: blocks.join("\n\n"),
    author,
    notes: [...new Set(notes)],
    uncertain: [...new Set(uncertain)],
    usage: results.map((result) => result.usage),
  };
}

export interface RewriteInput {
  source: PortSource;
  myTake: string;
  targets: PortTarget[];
  /** A requirement every title must meet, from a running experiment. */
  titleRule: string | null;
  allowed: Set<string>;
}

function requestContent(input: RewriteInput, feedback: string | null): string {
  const attributes = [
    input.source.author ? ` author="${escapeXml(input.source.author)}"` : "",
    input.source.url ? ` url="${escapeXml(input.source.url)}"` : "",
  ].join("");
  return [
    `<source${attributes}>\n${escapeXml(input.source.text)}\n</source>`,
    `<my_take>${escapeXml(input.myTake)}</my_take>`,
    `<targets>${input.targets.map((target) => `${target}（${portTargetLabels[target]}）`).join("、")}</targets>`,
    input.titleRule ? `<experiment>${escapeXml(input.titleRule)}</experiment>` : "",
    feedback ? `<feedback>${escapeXml(feedback)}</feedback>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * One rewrite for all targets. If any draft uses numbers that are in neither the original nor
 * the creator's take, it is asked once to rewrite without them; what remains is flagged.
 */
export async function rewriteForPlatforms(
  llm: StructuredLlm,
  input: RewriteInput,
): Promise<{ output: PortOutput; usage: UsageSummary[]; retried: boolean }> {
  const request = (feedback: string | null) =>
    llm.generate({
      stage: "reason",
      label: feedback ? "port-retry" : "port",
      system: portSystemPrompt,
      content: requestContent(input, feedback),
      schema: PortOutputSchema,
      maxTokens: 16000,
    });
  const first = await request(null);
  const invented = [
    ...new Set(first.data.drafts.flatMap((draft) => draftNumbers(draft, input.allowed))),
  ];
  if (invented.length === 0) return { output: first.data, usage: [first.usage], retried: false };
  const second = await request(
    `上一版用了原文和 <my_take> 里都没有的数字：${invented.join("、")}。请重写，不要用这些数字；读者确实需要的信息写进 checks。`,
  );
  return { output: second.data, usage: [first.usage, second.usage], retried: true };
}
