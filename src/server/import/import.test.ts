import { describe, expect, it } from "vitest";
import { platformIds, platforms } from "../../shared/platforms.js";
import { headerSignature, previewImport, tableToPosts } from "./mapping.js";
import {
  postsFromSinglePostExports,
  readSinglePostExport,
  stripSharedAffixes,
} from "./singlePost.js";
import { decodeText, ImportError, parseDelimitedText, parseImportFile } from "./table.js";
import { aliasMatches, parseMetricValue, parsePublishedAt } from "./values.js";
import { accountExport, noteExport, toXlsx } from "./workbookFixtures.js";

const asOf = "2026-10-12";

describe("parseMetricValue", () => {
  it("reads Chinese and English count formats", () => {
    expect(parseMetricValue("1.2万", "count")).toBe(12000);
    expect(parseMetricValue("10万+", "count")).toBe(100000);
    expect(parseMetricValue("3.5w", "count")).toBe(35000);
    expect(parseMetricValue("1,234", "count")).toBe(1234);
    expect(parseMetricValue("２３４", "count")).toBe(234);
    expect(parseMetricValue("1.1亿", "count")).toBe(110000000);
    expect(parseMetricValue("2.5k", "count")).toBe(2500);
    expect(parseMetricValue(87, "count")).toBe(87);
  });

  it("treats placeholders as missing, not zero", () => {
    for (const raw of ["", "-", "--", "—", "暂无", null, undefined]) {
      expect(parseMetricValue(raw, "count")).toBeNull();
    }
    expect(parseMetricValue("0", "count")).toBe(0);
  });

  it("reads rates as fractions", () => {
    expect(parseMetricValue("12.5%", "rate")).toBeCloseTo(0.125);
    expect(parseMetricValue("12.5", "rate")).toBeCloseTo(0.125);
    expect(parseMetricValue("0.3", "rate")).toBeCloseTo(0.3);
    expect(parseMetricValue(8.4, "rate")).toBeCloseTo(0.084);
  });

  it("reads durations in seconds", () => {
    expect(parseMetricValue("1:23", "duration")).toBe(83);
    expect(parseMetricValue("01:02:03", "duration")).toBe(3723);
    expect(parseMetricValue("1分23秒", "duration")).toBe(83);
    expect(parseMetricValue("45s", "duration")).toBe(45);
    expect(parseMetricValue("83秒", "duration")).toBe(83);
  });

  it("rejects text that is not a number", () => {
    expect(parseMetricValue("很多", "count")).toBeNull();
    expect(parseMetricValue("12abc", "count")).toBeNull();
  });
});

describe("parsePublishedAt", () => {
  it("keeps local wall-clock time", () => {
    expect(parsePublishedAt("2026-07-01 20:15", asOf)).toBe("2026-07-01T20:15");
    expect(parsePublishedAt("2026/7/1 8:05", asOf)).toBe("2026-07-01T08:05");
    expect(parsePublishedAt("2026年7月1日 20:15", asOf)).toBe("2026-07-01T20:15");
    expect(parsePublishedAt("2026-07-01", asOf)).toBe("2026-07-01");
  });

  it("fills a missing year with the latest date not after the reading date", () => {
    expect(parsePublishedAt("07-01 20:15", asOf)).toBe("2026-07-01T20:15");
    expect(parsePublishedAt("12-30", asOf)).toBe("2025-12-30");
  });

  it("resolves relative dates against the reading date", () => {
    expect(parsePublishedAt("3天前", asOf)).toBe("2026-10-09");
    expect(parsePublishedAt("昨天 21:30", asOf)).toBe("2026-10-11T21:30");
  });

  it("reads English month names and Excel serial dates", () => {
    expect(parsePublishedAt("Jul 1, 2026", asOf)).toBe("2026-07-01");
    expect(parsePublishedAt(46204, asOf)).toBe("2026-07-01");
  });

  it("returns null for impossible dates", () => {
    expect(parsePublishedAt("2026-02-30", asOf)).toBeNull();
    expect(parsePublishedAt("下周", asOf)).toBeNull();
  });
});

describe("aliasMatches", () => {
  it("accepts a bracketed unit after the alias", () => {
    expect(aliasMatches("观看数（人）", "观看数")).toBe(true);
    expect(aliasMatches("Watch time (hours)", "watch time (hours)")).toBe(true);
    expect(aliasMatches("观看时长", "观看")).toBe(false);
  });
});

/**
 * One fixture per platform. Headers follow public descriptions and common wording; none of them
 * is a real export file, so real exports still need a check with the user's own data.
 */
const fixtures: Record<(typeof platformIds)[number], string> = {
  xiaohongshu: [
    "笔记标题,发布时间,曝光,观看,点赞,收藏,评论,分享,涨粉",
    "3 个夏天必备的冰饮配方,2026-07-01 20:15,1.2万,3456,210,388,12,9,15",
    "我做了 30 天早餐，总结出这些,2026-07-04 08:30,8000,2100,98,120,4,3,2",
  ].join("\n"),
  douyin: [
    "作品标题\t发布时间\t播放量\t点赞\t评论\t分享\t收藏\t完播率\t平均播放时长",
    "教你 1 分钟做冰美式\t2026/7/1 20:00\t5.6w\t1200\t80\t45\t300\t32.5%\t0:18",
    "周末去哪儿？\t2026/7/3 12:00\t9800\t300\t12\t5\t40\t18%\t11秒",
  ].join("\n"),
  bilibili: [
    "稿件标题,投稿时间,播放,点赞,投币,收藏,弹幕,评论,分享",
    "【硬核】从零写一个编译器,2026-06-20 18:00,12.3万,8000,3000,5200,1200,600,300",
    "随便聊聊最近在忙什么,2026-06-27 21:00,8800,400,50,60,20,80,6",
  ].join("\n"),
  wechat: [
    "文章标题,发表时间,阅读人数,分享人数,在看,点赞,收藏",
    "为什么我不再用番茄钟,2026年6月30日,4321,120,35,60,88",
    "合计,,9999,,,,",
    "一个人的工作室：第一年复盘,2026年7月7日,10万+,900,210,400,512",
  ].join("\n"),
  youtube: [
    "Content,Video title,Video publish time,Duration,Views,Watch time (hours),Subscribers,Impressions,Impressions click-through rate (%)",
    "Total,,,,123456,3456.7,890,1000000,4.5",
    'abc123,I built an app in 7 days,"Jul 1, 2026",612,45678,1200.5,320,400000,5.1',
    'def456,Why my startup failed,"Jul 8, 2026",845,12000,300.2,40,150000,3.2',
  ].join("\n"),
};

describe("tableToPosts per platform", () => {
  it.each(platformIds)("imports a %s table", (platform) => {
    const result = tableToPosts(parseDelimitedText(fixtures[platform]), platform, asOf);
    expect(result.posts.length).toBe(2);
    const [first] = result.posts;
    expect(first?.title.length).toBeGreaterThan(0);
    expect(first?.publishedAt).not.toBeNull();
    const defaultMetric = platforms[platform].defaultMetric;
    expect(first?.metrics[defaultMetric]).toBeGreaterThan(0);
  });

  it("skips summary rows and reads 10万+ as a floor", () => {
    const result = tableToPosts(parseDelimitedText(fixtures.wechat), "wechat", asOf);
    expect(result.posts.map((post) => post.title)).not.toContain("合计");
    expect(result.posts[1]?.metrics.views).toBe(100000);
    expect(result.notes.join("")).toContain("合计行");
  });

  it("maps YouTube columns without mistaking the video ID for the title", () => {
    const result = tableToPosts(parseDelimitedText(fixtures.youtube), "youtube", asOf);
    expect(result.posts[0]?.title).toBe("I built an app in 7 days");
    expect(result.posts[0]?.metrics.ctr).toBeCloseTo(0.051);
    expect(result.posts[0]?.metrics.watchHours).toBeCloseTo(1200.5);
    expect(result.mapping.ignoredHeaders).toContain("Content");
  });

  it("reads Douyin rates and durations", () => {
    const result = tableToPosts(parseDelimitedText(fixtures.douyin), "douyin", asOf);
    expect(result.posts[0]?.metrics.completionRate).toBeCloseTo(0.325);
    expect(result.posts[0]?.metrics.avgWatchSeconds).toBe(18);
    expect(result.posts[1]?.metrics.avgWatchSeconds).toBe(11);
  });

  it("finds a header row below a report title", () => {
    const text = ["数据导出 2026-10-12", "", fixtures.xiaohongshu].join("\n");
    const result = tableToPosts(parseDelimitedText(text), "xiaohongshu", asOf);
    expect(result.mapping.headerRow).toBe(1);
    expect(result.posts).toHaveLength(2);
  });

  it("explains a table without a title column", () => {
    expect(() =>
      tableToPosts(parseDelimitedText("日期,播放\n2026-07-01,100"), "douyin", asOf),
    ).toThrow(ImportError);
  });

  it("merges duplicate rows from overlapping exports", () => {
    const lines = fixtures.bilibili.split("\n");
    const text = [...lines, lines[1]].join("\n");
    const result = tableToPosts(parseDelimitedText(text), "bilibili", asOf);
    expect(result.posts).toHaveLength(2);
    expect(result.notes.join("")).toContain("重复");
  });
});

describe("file decoding", () => {
  it("falls back to GB18030 for exports saved by Chinese Excel", () => {
    // "标题" encoded in GBK.
    const gbk = Buffer.from([0xb1, 0xea, 0xcc, 0xe2]);
    expect(decodeText(gbk)).toBe("标题");
    expect(decodeText(Buffer.from("标题", "utf8"))).toBe("标题");
  });

  it("rejects legacy .xls with a fix the user can do", async () => {
    await expect(parseImportFile("data.xls", "AAAA", "base64")).rejects.toThrow(/另存为/);
  });
});

describe("manual column mapping", () => {
  // Headers nobody has an alias for, like a renamed or translated export.
  const odd = ["名字,日子,数A,数B", "早餐 A,2026-07-01,1200,30", "早餐 B,2026-07-02,800,12"].join(
    "\n",
  );

  it("previews an unrecognised table instead of failing", () => {
    const preview = previewImport(parseDelimitedText(odd), "xiaohongshu", asOf, undefined, false);
    expect(preview.complete).toBe(false);
    expect(preview.missing.join("")).toContain("标题列");
    expect(preview.headers).toEqual(["名字", "日子", "数A", "数B"]);
    expect(preview.samples[0]).toEqual(["早餐 A", "2026-07-01", "1200", "30"]);
    expect(preview.fields.map((field) => field.id)).toContain("metric:views");
  });

  it("imports with the columns the user assigned", () => {
    const assignment = {
      headerRow: 0,
      columns: ["title", "publishedAt", "metric:views", "metric:likes"],
    };
    const result = tableToPosts(parseDelimitedText(odd), "xiaohongshu", asOf, assignment);
    expect(result.posts[0]).toMatchObject({ title: "早餐 A", publishedAt: "2026-07-01" });
    expect(result.posts[0]?.metrics).toMatchObject({ views: 1200, likes: 30 });
  });

  it("rejects a field assigned to two columns or an unknown field", () => {
    const table = parseDelimitedText(odd);
    expect(() =>
      tableToPosts(table, "xiaohongshu", asOf, {
        headerRow: 0,
        columns: ["title", "title", "metric:views", null],
      }),
    ).toThrow(/同时对应了两列/);
    expect(() =>
      tableToPosts(table, "xiaohongshu", asOf, {
        headerRow: 0,
        columns: ["title", null, "metric:coins", null],
      }),
    ).toThrow(/不认识的字段/);
  });

  it("tells the user where to fix a missing title column", () => {
    expect(() => tableToPosts(parseDelimitedText(odd), "xiaohongshu", asOf)).toThrow(/列对应/);
  });

  it("gives the same signature to the same layout regardless of spacing and width", () => {
    expect(headerSignature(["笔记 标题", "观看"])).toBe(headerSignature(["笔记标题", "观看"]));
  });
});

describe("Xiaohongshu data centre names", () => {
  it("reads every per-note metric name shown in the creator data centre", () => {
    // Metric names and number styles as shown in the 2026-10 "笔记数据总览" screenshot.
    const text = [
      "笔记标题,发布时间,曝光数,观看数,封面点击率,视频完播率,点赞数,评论数,收藏数,分享数,净涨粉",
      '第一篇,2026-09-20 21:00,"3,643",548,16.9 %,0 %,13,4,1,11,2',
    ].join("\n");
    const result = tableToPosts(parseDelimitedText(text), "xiaohongshu", asOf);
    expect(result.mapping.ignoredHeaders).toEqual([]);
    expect(result.posts[0]?.metrics).toMatchObject({
      impressions: 3643,
      views: 548,
      likes: 13,
      comments: 4,
      collects: 1,
      shares: 11,
      follows: 2,
      completionRate: 0,
    });
    expect(result.posts[0]?.metrics.coverCtr).toBeCloseTo(0.169);
  });
});

describe("account-level exports", () => {
  // Layout of Xiaohongshu's "近30日观看数据" Excel export (checked 2026-10-12), with made-up
  // numbers: a totals sheet first, then one daily-trend sheet per metric.
  const totals = [
    ["指标", "数值"],
    ["曝光", 1200],
    ["观看", 300],
    ["封面点击率(%)", 12.5],
    ["平均观看时长(s)", 9.1],
    ["总观看时长(s)", 2730],
    ["总完播率(%)", 0],
    ["曝光环比(%)", 150],
  ];
  const daily = [
    ["日期", "数值"],
    ["2026年10月11日", "0%"],
    ["2026年10月10日", "50%"],
    ["2026年10月09日", "6%"],
    ["2026年10月08日", "12%"],
  ];

  it("explains a totals table instead of offering column mapping", () => {
    expect(() => previewImport(totals, "xiaohongshu", asOf, undefined, false)).toThrow(/合计数据/);
    const forced = { headerRow: 0, columns: ["title", "metric:views"] };
    expect(() => tableToPosts(totals, "xiaohongshu", asOf, forced)).toThrow(/按笔记列出的明细/);
  });

  it("explains a daily trend table, whatever unit its values carry", () => {
    const durations = [
      ["日期", "数值"],
      ["2026年10月09日", "26秒"],
      ["2026年10月08日", "11秒"],
      ["2026年10月07日", "0秒"],
    ];
    for (const table of [daily, durations]) {
      try {
        tableToPosts(table, "xiaohongshu", asOf);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ImportError);
        expect((error as ImportError).code).toBe("account_level");
        expect((error as ImportError).message).toContain("按天汇总");
      }
    }
  });

  it("still imports per-post tables that start with a date column", () => {
    const table = [
      ["发布时间", "笔记标题", "观看数"],
      ["2026年10月01日", "第一篇", 120],
      ["2026年10月03日", "第二篇", 80],
      ["2026年10月05日", "第三篇", 95],
    ];
    expect(tableToPosts(table, "xiaohongshu", asOf).posts).toHaveLength(3);
  });

  it("reads bare numbers under a (%) header as percentages", () => {
    const table = [
      ["笔记标题", "观看数", "封面点击率(%)", "视频完播率", "平均观看时长(s)"],
      ["第一篇", 548, 0.8, 0.8, 15.3],
      ["第二篇", 120, 16.9, "16.9 %", 2],
    ];
    const [first, second] = tableToPosts(table, "xiaohongshu", asOf).posts;
    expect(first?.metrics.coverCtr).toBeCloseTo(0.008);
    expect(first?.metrics.completionRate).toBeCloseTo(0.8);
    expect(first?.metrics.avgWatchSeconds).toBeCloseTo(15.3);
    expect(second?.metrics.coverCtr).toBeCloseTo(0.169);
    expect(second?.metrics.completionRate).toBeCloseTo(0.169);
  });
});

describe("single-post exports", () => {
  const note = noteExport({
    startDay: "2026-09-23",
    impressions: 1500,
    views: 300,
    ctrPercent: 20,
  });

  it("reads every sheet of a workbook whose file name lost its extension", async () => {
    const content = (await toXlsx(note)).toString("base64");
    const sheets = await parseImportFile("Claude Opus 5.5 上手", content, "base64");
    expect(sheets.map((sheet) => sheet.name)).toEqual([
      "基础数据总览",
      "曝光数（天）",
      "平均观看时长（小时）",
    ]);
    expect(sheets[1]?.table[1]).toEqual(["2026年09月23日", 1200]);
  });

  it("turns one note's export into one post", () => {
    const post = readSinglePostExport(note, "我的笔记 (1).xlsx", "xiaohongshu", asOf);
    expect(post?.title).toBe("我的笔记");
    // The earliest hour on the earliest day stands in for the publish time.
    expect(post?.publishedAt).toBe("2026-09-23T09:00");
    expect(post?.metrics).toMatchObject({
      impressions: 1500,
      views: 300,
      avgWatchSeconds: 8.5,
      completionRate: 0,
      follows: 2,
    });
    expect(post?.metrics.coverCtr).toBeCloseTo(0.2);
  });

  it("does not mistake the account export for a note", () => {
    expect(readSinglePostExport(accountExport(), "近30日观看数据.xlsx", "xiaohongshu", asOf)).toBe(
      null,
    );
  });

  it("combines several note files and refuses to mix in other files", () => {
    const second = noteExport({
      startDay: "2026-10-02",
      impressions: 80,
      views: 9,
      ctrPercent: 11,
    });
    const result = postsFromSinglePostExports(
      [
        { fileName: "第一篇.xlsx", sheets: note },
        { fileName: "第二篇.xlsx", sheets: second },
        { fileName: "第一篇.xlsx", sheets: note },
      ],
      "xiaohongshu",
      asOf,
    );
    expect(result?.posts.map((post) => [post.id, post.title])).toEqual([
      ["p1", "第一篇"],
      ["p2", "第二篇"],
    ]);
    expect(result?.notes.join("")).toContain("合并了 1 个");

    const table = [{ name: "", table: parseDelimitedText("标题,观看\n一,1") }];
    expect(
      postsFromSinglePostExports([{ fileName: "list.csv", sheets: table }], "xiaohongshu", asOf),
    ).toBe(null);
    expect(() =>
      postsFromSinglePostExports(
        [
          { fileName: "第一篇.xlsx", sheets: note },
          { fileName: "list.csv", sheets: table },
        ],
        "xiaohongshu",
        asOf,
      ),
    ).toThrow(/list\.csv/);
  });
});

describe("stripSharedAffixes", () => {
  it("removes a suffix or prefix every file name repeats after a separator", () => {
    expect(stripSharedAffixes(["一周计划-笔记数据", "年度规划-笔记数据"])).toEqual({
      titles: ["一周计划", "年度规划"],
      removed: ["-笔记数据"],
    });
    expect(stripSharedAffixes(["小红书_早餐", "小红书_通勤", "小红书_早餐"])).toEqual({
      titles: ["早餐", "通勤", "早餐"],
      removed: ["小红书_"],
    });
  });

  it("leaves titles alone when nothing shared is set off by a separator", () => {
    const unchanged = (titles: string[]) =>
      expect(stripSharedAffixes(titles)).toEqual({ titles, removed: [] });
    unchanged(["早餐日记", "通勤日记"]);
    unchanged(["A-B", "A-B"]);
    unchanged(["一篇"]);
    unchanged(["做饭-数据", "-数据"]);
  });

  it("is applied to several note files and reported", () => {
    const sheets = noteExport({
      startDay: "2026-09-23",
      impressions: 500,
      views: 50,
      ctrPercent: 10,
    });
    const result = postsFromSinglePostExports(
      [
        { fileName: "早餐这样吃-笔记数据.xlsx", sheets },
        { fileName: "通勤穿搭-笔记数据 (1).xlsx", sheets },
      ],
      "xiaohongshu",
      asOf,
    );
    expect(result?.posts.map((post) => post.title)).toEqual(["早餐这样吃", "通勤穿搭"]);
    expect(result?.notes.join("")).toContain("“-笔记数据”");
  });
});

describe("YouTube Studio exports (real layouts)", () => {
  // Header rows copied verbatim from public Studio exports (2026 and 2022, English UI);
  // the numbers, titles and IDs are made up. Line 2 is always Studio's Total row.
  it("prefers the exact Views column over a bracketed variant", () => {
    const header =
      "Content,Video title,Video publish time,Duration,Engaged views,Average view duration,Average percentage viewed (%),Stayed to watch (%),Unique viewers,Unique reach,Views (co-viewed),Average views per viewer,New viewers,Returning viewers,Casual viewers,Regular viewers,Subscribers gained,Likes,Shares,Views,Watch time (hours),Subscribers,Thumbnail impressions,Thumbnail click-through rate (%)";
    const text = [
      header,
      "Total,,,,900,0:00:30,61.2,55.1,700,800,950,1.3,,,,,30,120,8,1000,12.5,25,20000,4.8",
      ' -AbCdEf123,<title one>,"Sep 6, 2026",69,500,0:00:44,109.75,60.2,400,450,520,1.2,,,,,20,80,5,540,6.6,18,9000,5.52',
    ].join("\n");
    const result = tableToPosts(parseDelimitedText(text), "youtube", asOf);
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]?.publishedAt).toBe("2026-09-06");
    expect(result.posts[0]?.metrics).toMatchObject({
      views: 540,
      watchHours: 6.6,
      impressions: 9000,
      avgViewSeconds: 44,
      likes: 80,
      shares: 5,
      follows: 18,
    });
    expect(result.posts[0]?.metrics.ctr).toBeCloseTo(0.0552);
    expect(result.posts[0]?.metrics.avgPercentViewed).toBeCloseTo(1.0975);
    expect(result.mapping.ignoredHeaders).toContain("Views (co-viewed)");
  });

  it("reads headers with soft hyphens inside words", () => {
    const header =
      "Video,Video title,Video pub­lish time,Com­ments ad­ded,Shares,Dis­likes,Likes,Sub­scribers lost,Sub­scribers gained,RPM (USD),CPM (USD),Av­er­age per­cent­age viewed (%),Av­er­age view dur­a­tion,Views,Watch time (hours),Sub­scribers,Your es­tim­ated rev­en­ue (USD),Im­pres­sions,Im­pres­sions click-through rate (%)";
    const text = [
      header,
      "Total,,,10,20,1,300,2,40,5.1,9.2,40.5,0:02:10,5000,400.5,38,25.5,90000,4.2",
      'AbCdEf456,<title two>,"May 8, 2020",3,7,0,90,1,12,4.9,,36.65,0:03:09,1500,120.25,11,7.75,30000,3.14',
    ].join("\n");
    const post = tableToPosts(parseDelimitedText(text), "youtube", asOf).posts[0];
    expect(post?.publishedAt).toBe("2020-05-08");
    expect(post?.metrics).toMatchObject({
      views: 1500,
      comments: 3,
      impressions: 30000,
      avgViewSeconds: 189,
      follows: 11,
    });
    expect(post?.metrics.ctr).toBeCloseTo(0.0314);
  });

  it("only treats unit-like brackets as part of a metric name", () => {
    expect(aliasMatches("Views (co-viewed)", "views")).toBe(false);
    expect(aliasMatches("Thumbnail click-through rate (%)", "thumbnail click-through rate")).toBe(
      true,
    );
    expect(aliasMatches("播放量（次）", "播放量")).toBe(true);
    expect(aliasMatches("Video pub­lish time", "video publish time")).toBe(true);
  });
});
