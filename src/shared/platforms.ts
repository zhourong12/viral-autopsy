/**
 * Platform registry: metric dictionaries, column aliases for imports, and how each platform's
 * data can be brought in. Import-path statuses are deliberately conservative: "documented" only
 * when a public source described the export, "unverified" otherwise.
 */

export const platformIds = ["xiaohongshu", "douyin", "bilibili", "wechat", "youtube"] as const;
export type PlatformId = (typeof platformIds)[number];

export type MetricKind = "count" | "rate" | "duration";

export interface MetricDef {
  key: string;
  label: string;
  kind: MetricKind;
  /** Column headers seen in exports or written by people, compared case- and space-insensitively. */
  aliases: string[];
}

export type ImportPathKind = "export" | "screenshot" | "paste";
export type ImportPathStatus = "documented" | "unverified" | "always";

export interface ImportPath {
  kind: ImportPathKind;
  status: ImportPathStatus;
  note: string;
}

export interface PlatformDef {
  id: PlatformId;
  label: string;
  /** What one piece of content is called on this platform. */
  contentNoun: string;
  metrics: MetricDef[];
  /** Metric the analysis uses unless the user picks another. */
  defaultMetric: string;
  /** Days after publishing before a post's numbers count as settled. */
  maturityDays: number;
  importPaths: ImportPath[];
}

const titleAliases = [
  "标题",
  "笔记标题",
  "作品标题",
  "稿件标题",
  "文章标题",
  "视频标题",
  "作品名称",
  "内容",
  "title",
  "video title",
  "content title",
];
const publishedAtAliases = [
  "发布时间",
  "发布日期",
  "发表时间",
  "发文时间",
  "群发时间",
  "投稿时间",
  "创建时间",
  "日期",
  "时间",
  "publish time",
  "video publish time",
  "published",
  "published at",
  "date",
];
const formatAliases = ["类型", "体裁", "内容类型", "笔记类型", "作品类型", "format", "type"];
const urlAliases = ["链接", "作品链接", "笔记链接", "文章链接", "url", "link"];

export const columnAliases = {
  title: titleAliases,
  publishedAt: publishedAtAliases,
  format: formatAliases,
  url: urlAliases,
} as const;

const screenshot: ImportPath = {
  kind: "screenshot",
  status: "always",
  note: "上传数据中心的作品列表截图，AI 识别成表格后由你逐格确认。需要配置 AI。",
};
const paste: ImportPath = {
  kind: "paste",
  status: "always",
  note: "从表格软件复制粘贴，或手动填写。",
};

export const platforms: Record<PlatformId, PlatformDef> = {
  xiaohongshu: {
    id: "xiaohongshu",
    label: "小红书",
    contentNoun: "笔记",
    defaultMetric: "views",
    maturityDays: 7,
    metrics: [
      {
        key: "impressions",
        label: "曝光",
        kind: "count",
        aliases: ["曝光", "曝光数", "曝光量", "impressions"],
      },
      {
        key: "views",
        label: "观看",
        kind: "count",
        aliases: ["观看", "观看数", "观看量", "阅读", "阅读数", "浏览", "浏览量", "views"],
      },
      { key: "likes", label: "点赞", kind: "count", aliases: ["点赞", "点赞数", "likes"] },
      {
        key: "collects",
        label: "收藏",
        kind: "count",
        aliases: ["收藏", "收藏数", "collects", "saves"],
      },
      { key: "comments", label: "评论", kind: "count", aliases: ["评论", "评论数", "comments"] },
      { key: "shares", label: "分享", kind: "count", aliases: ["分享", "分享数", "shares"] },
      {
        key: "follows",
        label: "净涨粉",
        kind: "count",
        // "净涨粉" and "新增关注" are the names in the creator data centre (checked 2026-10-12).
        aliases: ["净涨粉", "涨粉", "涨粉数", "新增关注", "新增粉丝", "followers gained"],
      },
      {
        key: "coverCtr",
        label: "封面点击率",
        kind: "rate",
        aliases: ["封面点击率", "点击率", "ctr"],
      },
      {
        key: "completionRate",
        label: "视频完播率",
        kind: "rate",
        aliases: ["视频完播率", "完播率"],
      },
      {
        key: "avgWatchSeconds",
        label: "平均观看时长",
        kind: "duration",
        // "平均观看时长(s)" is the header in the data-centre Excel export (checked 2026-10-12).
        aliases: ["平均观看时长", "人均观看时长", "avg watch time"],
      },
    ],
    importPaths: [
      {
        kind: "export",
        status: "unverified",
        note: "创作服务平台的数据中心能查看笔记数据，但没有查到官方导出说明。若你的后台能导出，可直接上传。",
      },
      screenshot,
      paste,
    ],
  },
  douyin: {
    id: "douyin",
    label: "抖音",
    contentNoun: "作品",
    defaultMetric: "views",
    maturityDays: 7,
    metrics: [
      {
        key: "views",
        label: "播放",
        kind: "count",
        aliases: ["播放", "播放量", "播放数", "views", "plays"],
      },
      {
        key: "likes",
        label: "点赞",
        kind: "count",
        aliases: ["点赞", "点赞数", "点赞量", "likes"],
      },
      {
        key: "comments",
        label: "评论",
        kind: "count",
        aliases: ["评论", "评论数", "评论量", "comments"],
      },
      {
        key: "shares",
        label: "分享",
        kind: "count",
        aliases: ["分享", "分享数", "分享量", "shares"],
      },
      {
        key: "collects",
        label: "收藏",
        kind: "count",
        aliases: ["收藏", "收藏数", "收藏量", "collects"],
      },
      {
        key: "follows",
        label: "涨粉",
        kind: "count",
        aliases: ["涨粉", "涨粉数", "新增粉丝", "粉丝增量"],
      },
      {
        key: "completionRate",
        label: "完播率",
        kind: "rate",
        aliases: ["完播率", "completion rate"],
      },
      {
        key: "avgWatchSeconds",
        label: "平均播放时长",
        kind: "duration",
        aliases: ["平均播放时长", "平均观看时长", "avg watch time"],
      },
    ],
    importPaths: [
      {
        kind: "export",
        status: "unverified",
        note: "创作者服务中心的数据中心能查看作品数据，没有查到官方导出说明。若你的后台能导出，可直接上传。",
      },
      screenshot,
      paste,
    ],
  },
  bilibili: {
    id: "bilibili",
    label: "B 站",
    contentNoun: "稿件",
    defaultMetric: "views",
    maturityDays: 7,
    metrics: [
      {
        key: "views",
        label: "播放",
        kind: "count",
        aliases: ["播放", "播放量", "播放数", "views"],
      },
      { key: "likes", label: "点赞", kind: "count", aliases: ["点赞", "点赞数", "likes"] },
      { key: "coins", label: "投币", kind: "count", aliases: ["投币", "硬币", "投币数", "coins"] },
      { key: "collects", label: "收藏", kind: "count", aliases: ["收藏", "收藏数", "collects"] },
      { key: "danmaku", label: "弹幕", kind: "count", aliases: ["弹幕", "弹幕数", "danmaku"] },
      { key: "comments", label: "评论", kind: "count", aliases: ["评论", "评论数", "comments"] },
      { key: "shares", label: "分享", kind: "count", aliases: ["分享", "分享数", "shares"] },
      {
        key: "follows",
        label: "涨粉",
        kind: "count",
        aliases: ["涨粉", "新增粉丝", "followers gained"],
      },
    ],
    importPaths: [
      {
        kind: "export",
        status: "unverified",
        note: "没有查到创作中心导出稿件数据的公开说明。若你的后台能导出，可直接上传。",
      },
      screenshot,
      paste,
    ],
  },
  wechat: {
    id: "wechat",
    label: "公众号",
    contentNoun: "文章",
    defaultMetric: "views",
    maturityDays: 7,
    metrics: [
      {
        key: "views",
        label: "阅读",
        kind: "count",
        aliases: [
          "阅读",
          "阅读数",
          "阅读量",
          "阅读次数",
          "阅读人数",
          "总阅读人数",
          "总阅读次数",
          "views",
        ],
      },
      {
        key: "shares",
        label: "分享",
        kind: "count",
        aliases: ["分享", "分享次数", "分享人数", "转发", "shares"],
      },
      { key: "likes", label: "点赞", kind: "count", aliases: ["点赞", "点赞数", "likes"] },
      { key: "wows", label: "在看", kind: "count", aliases: ["在看", "在看数", "推荐"] },
      {
        key: "collects",
        label: "收藏",
        kind: "count",
        aliases: ["收藏", "收藏次数", "收藏人数", "collects"],
      },
      {
        key: "follows",
        label: "新增关注",
        kind: "count",
        aliases: ["新增关注", "关注", "阅读后关注", "涨粉"],
      },
      { key: "completionRate", label: "完读率", kind: "rate", aliases: ["完读率", "阅读完成率"] },
    ],
    importPaths: [
      {
        kind: "export",
        status: "documented",
        note: "公众号后台的数据分析能导出文章数据（多篇中文资料描述过；具体列名以你的后台为准，导入时会让你确认对应关系）。",
      },
      screenshot,
      paste,
    ],
  },
  youtube: {
    id: "youtube",
    label: "YouTube",
    contentNoun: "视频",
    defaultMetric: "views",
    maturityDays: 7,
    metrics: [
      { key: "views", label: "观看次数", kind: "count", aliases: ["views", "观看次数", "观看"] },
      {
        key: "watchHours",
        label: "观看时长（小时）",
        kind: "count",
        aliases: ["watch time (hours)", "watch time", "观看时长（小时）", "观看时长"],
      },
      {
        key: "impressions",
        label: "展示次数",
        kind: "count",
        aliases: ["impressions", "展示次数"],
      },
      {
        key: "ctr",
        label: "展示点击率",
        kind: "rate",
        aliases: [
          "impressions click-through rate (%)",
          "impressions click-through rate",
          "click-through rate",
          "展示点击率",
        ],
      },
      {
        key: "avgViewSeconds",
        label: "平均观看时长",
        kind: "duration",
        aliases: ["average view duration", "平均观看时长"],
      },
      { key: "likes", label: "顶", kind: "count", aliases: ["likes", "顶"] },
      {
        key: "comments",
        label: "评论",
        kind: "count",
        aliases: ["comments added", "comments", "评论"],
      },
      {
        key: "follows",
        label: "订阅者",
        kind: "count",
        aliases: ["subscribers", "subscribers gained", "订阅者", "新增订阅者"],
      },
    ],
    importPaths: [
      {
        kind: "export",
        status: "documented",
        note: "YouTube Studio 数据分析可以导出 CSV（第三方教程描述过，没有查到官方帮助页）。导入时会让你确认列的对应关系。",
      },
      screenshot,
      paste,
    ],
  },
};

export function getPlatform(id: PlatformId): PlatformDef {
  return platforms[id];
}

export function isPlatformId(value: string): value is PlatformId {
  return (platformIds as readonly string[]).includes(value);
}

export function metricDef(platform: PlatformId, key: string): MetricDef | undefined {
  return platforms[platform].metrics.find((metric) => metric.key === key);
}
