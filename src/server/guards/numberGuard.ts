/**
 * The AI may only use numbers the engine produced. This guard extracts every number from a
 * piece of AI text and reports the ones that do not appear in the engine's own output.
 */

const digitPattern = /(?<![\d.])(\d+(?:,\d{3})*(?:\.\d+)?)(?![\d])/g;

const chineseDigits: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** "十二" -> 12, "三十" -> 30, "九十九" -> 99. Larger numbers are left to digits. */
function chineseToNumber(text: string): number | null {
  if (text === "十") return 10;
  const match = text.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (match) {
    const tens = match[1] ? (chineseDigits[match[1]] ?? 0) : 1;
    const ones = match[2] ? (chineseDigits[match[2]] ?? 0) : 0;
    return tens * 10 + ones;
  }
  if (text.length === 1 && text in chineseDigits) return chineseDigits[text] ?? null;
  return null;
}

function canonical(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

export function extractNumbers(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(digitPattern)) {
    if (match[1]) found.push(canonical(Number(match[1].replace(/,/g, ""))));
  }
  // Counted Chinese numerals ("三条", "十二篇") are claims too.
  for (const match of text.matchAll(
    /([零一二两三四五六七八九十]{1,3})(?=\s*(?:条|篇|个|组|次|天|项|倍|成))/g,
  )) {
    const value = match[1] ? chineseToNumber(match[1]) : null;
    if (value !== null) found.push(canonical(value));
  }
  return found;
}

export function buildAllowedNumbers(sources: string[], extra: number[] = []): Set<string> {
  const allowed = new Set<string>();
  for (const source of sources) for (const value of extractNumbers(source)) allowed.add(value);
  for (const value of extra) allowed.add(canonical(value));
  // Small structural numbers ("一条", "两组", "第一") carry no data claim.
  for (const value of [0, 1, 2]) allowed.add(canonical(value));
  return allowed;
}

export function unverifiedNumbers(text: string, allowed: Set<string>): string[] {
  return [...new Set(extractNumbers(text).filter((value) => !allowed.has(value)))];
}
