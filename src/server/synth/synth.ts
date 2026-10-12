import { getPlatform, type PlatformId } from "../../shared/platforms.js";
import type { ContentFormat, HookType, Post, PostLabels } from "../../shared/schemas.js";
import { createRng, type Rng } from "../engine/stats.js";

/**
 * Synthetic creator accounts with known answers. Used by tests, the engine eval and the
 * "sample account" button in the UI, which always labels it as synthetic.
 *
 * Planted truth:
 * - Real: question titles get 1.8× the main metric; tutorials get 2.5× the collect rate.
 * - Trap (time confound): face covers have no effect but cluster in the fast-growth months.
 * - Trap (outlier): one post 25× above normal happens to have a number in its title.
 * - Everything else: no effect.
 */

export interface SynthOptions {
  platform: PlatformId;
  seed: number;
  posts?: number;
  /** First publish date, YYYY-MM-DD. */
  start?: string;
  questionEffect?: number;
  tutorialCollectEffect?: number;
}

export interface SynthAccount {
  posts: Post[];
  labels: Record<string, PostLabels>;
  asOf: string;
  truth: {
    /** Hypothesis IDs from the myth library that are really true in this data. */
    real: string[];
    /** Myth IDs built as traps: they look true to naive analysis but are not. */
    traps: string[];
  };
}

const topicsByPlatform: Record<PlatformId, string[]> = {
  xiaohongshu: ["早餐", "通勤穿搭", "租房改造"],
  douyin: ["咖啡", "健身", "数码"],
  bilibili: ["编程", "游戏", "读书"],
  wechat: ["效率", "创业", "写作"],
  youtube: ["coding", "startup", "productivity"],
};

function normal(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function addDays(start: string, days: number): string {
  const date = new Date(`${start}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

interface Traits {
  question: boolean;
  number: boolean;
  emoji: boolean;
  exclaim: boolean;
  firstPerson: boolean;
  brackets: boolean;
  hype: boolean;
  tutorial: boolean;
  story: boolean;
  emotional: boolean;
  face: boolean;
  bigText: boolean;
}

function buildTitle(topic: string, traits: Traits, rng: Rng, english: boolean): string {
  if (english) {
    let title = traits.tutorial ? `How to get started with ${topic}` : `Notes on ${topic}`;
    if (traits.number) title = `${3 + Math.floor(rng() * 7)} lessons from ${topic}`;
    if (traits.firstPerson) title = `My ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
    if (traits.question) title = `Why does ${topic} feel so hard?`;
    if (traits.hype) title = `${title} (insane)`;
    if (traits.brackets) title = `[${topic}] ${title}`;
    if (traits.exclaim) title = `${title}!`;
    if (traits.emoji) title = `${title} 🔥`;
    return title;
  }
  const subject = traits.firstPerson ? `我的${topic}` : topic;
  let title = traits.tutorial ? `${subject}入门做法` : `关于${subject}的一些记录`;
  if (traits.number) title = `${subject}的 ${3 + Math.floor(rng() * 7)} 个心得`;
  if (traits.question) title = `为什么${subject}总是做不好？`;
  if (traits.story) title = `${title}，那段经历`;
  if (traits.hype) title = `${title}，绝了`;
  if (traits.brackets) title = `【${topic}】${title}`;
  if (traits.exclaim) title = `${title}！`;
  if (traits.emoji) title = `${title}✨`;
  return title;
}

function hookOf(traits: Traits): HookType {
  if (traits.question) return "question";
  if (traits.number) return "number";
  if (traits.tutorial) return "tutorial";
  if (traits.story) return "story";
  if (traits.emotional) return "emotion";
  return "other";
}

export function generateAccount(options: SynthOptions): SynthAccount {
  const rng = createRng(options.seed);
  const platform = getPlatform(options.platform);
  const count = options.posts ?? 60;
  const start = options.start ?? "2026-03-02";
  const questionEffect = Math.log2(options.questionEffect ?? 1.8);
  const tutorialCollect = options.tutorialCollectEffect ?? 2.5;
  const topics = topicsByPlatform[options.platform];
  const english = options.platform === "youtube";
  const hours = [8, 12, 19, 21];
  const outlierIndex = Math.floor(count * 0.45) + Math.floor(rng() * Math.floor(count * 0.2));

  const posts: Post[] = [];
  const labels: Record<string, PostLabels> = {};
  let day = 0;
  for (let i = 0; i < count; i += 1) {
    day += 2 + Math.floor(rng() * 3);
    const progress = i / Math.max(1, count - 1);
    const traits: Traits = {
      question: rng() < 0.35,
      number: i === outlierIndex ? true : rng() < 0.35,
      emoji: rng() < 0.3,
      exclaim: rng() < 0.25,
      firstPerson: rng() < 0.35,
      brackets: rng() < 0.2,
      hype: rng() < 0.25,
      tutorial: rng() < 0.4,
      story: rng() < 0.3,
      emotional: rng() < 0.25,
      // The trap: face covers become common exactly when the account grows fastest.
      face: rng() < (progress > 0.55 ? 0.8 : 0.12),
      bigText: rng() < 0.5,
    };
    if (i === outlierIndex) traits.question = false;
    const topic = topics[Math.floor(rng() * topics.length)] as string;
    const title = buildTitle(topic, traits, rng, english);
    const hour = hours[Math.floor(rng() * hours.length)] as number;
    const minute = Math.floor(rng() * 60);
    const date = addDays(start, day);
    const format: ContentFormat =
      options.platform === "wechat"
        ? "article"
        : options.platform === "xiaohongshu"
          ? rng() < 0.3
            ? "video"
            : "image"
          : "video";

    // Main metric in log2: growing account (late growth spurt), planted effect, noise, outlier.
    const growth = 10.5 + 1.2 * progress + (1.8 * Math.max(0, progress - 0.55)) / 0.45;
    let log2Main = growth + normal(rng) * 0.6;
    if (traits.question) log2Main += questionEffect;
    if (i === outlierIndex) log2Main += Math.log2(25);
    const main = Math.round(2 ** log2Main);
    const collectRate = 0.02 * (traits.tutorial ? tutorialCollect : 1) * 2 ** (normal(rng) * 0.3);
    const likeRate = 0.05 * 2 ** (normal(rng) * 0.3);

    const metrics: Record<string, number | null> = {};
    for (const metric of platform.metrics) {
      let value: number;
      switch (metric.key) {
        case "views":
          value = main;
          break;
        case "impressions":
          value = Math.round(main * (3 + rng() * 2));
          break;
        case "collects":
          value = Math.round(main * collectRate);
          break;
        case "likes":
          value = Math.round(main * likeRate);
          break;
        case "coins":
          value = Math.round(main * likeRate * 0.4);
          break;
        case "comments":
        case "danmaku":
          value = Math.round(main * 0.006 * 2 ** (normal(rng) * 0.4));
          break;
        case "shares":
        case "wows":
          value = Math.round(main * 0.004 * 2 ** (normal(rng) * 0.4));
          break;
        case "follows":
          value = Math.round(main * 0.003 * 2 ** (normal(rng) * 0.5));
          break;
        case "watchHours":
          value = Math.round(main * 0.05 * 10) / 10;
          break;
        default:
          if (metric.kind === "rate") value = Math.round((0.05 + rng() * 0.3) * 1000) / 1000;
          else if (metric.kind === "duration") value = Math.round(20 + rng() * 120);
          else value = Math.round(main * 0.01);
      }
      metrics[metric.key] = value;
    }

    const id = `p${i + 1}`;
    posts.push({
      id,
      title,
      publishedAt: `${date}T${pad(hour)}:${pad(minute)}`,
      format,
      metrics,
      url: null,
    });
    labels[id] = {
      hookType: hookOf(traits),
      topic,
      isTutorial: traits.tutorial,
      emotional: traits.emotional,
      personalStory: traits.story,
      coverFace: traits.face,
      coverBigText: traits.bigText,
    };
  }
  const lastDate = posts[posts.length - 1]?.publishedAt?.slice(0, 10) ?? start;
  const real = ["myth-question"];
  if (platform.metrics.some((metric) => metric.key === "collects"))
    real.push("myth-tutorial-collects");
  return {
    posts,
    labels,
    asOf: addDays(lastDate, 10),
    truth: { real, traps: ["myth-face", "myth-number"] },
  };
}
