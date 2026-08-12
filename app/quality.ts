export type IssueCategory = "html" | "grammar" | "seo" | "accessibility";
export type IssueSeverity = "error" | "warning" | "suggestion";

export type QualityIssue = {
  type: IssueCategory;
  severity: IssueSeverity;
};

export type TextSegment = { text: string; line: number };

export type GrammarFinding = {
  title: string;
  message: string;
  replacement?: string;
  index: number;
};

const IGNORED_SELECTOR = "script,style,template,noscript,svg,canvas,[hidden],[aria-hidden='true']";
const PHRASE_CONTAINERS = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "P", "LI", "DT", "DD", "FIGCAPTION", "CAPTION", "LEGEND", "LABEL", "BUTTON", "TD", "TH", "OPTION"]);
const FALLBACK_CONTAINERS = new Set(["DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "NAV", "ASIDE", "A"]);

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Return the complete sentence containing a grammar match. */
export function extractSentenceAt(text: string, index: number): string {
  const safeIndex = Math.max(0, Math.min(index, text.length));
  let start = safeIndex;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start -= 1;
  let end = safeIndex;
  while (end < text.length && !/[.!?\n]/.test(text[end])) end += 1;
  if (end < text.length && /[.!?]/.test(text[end])) end += 1;
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * Resolve a lint position back to the original HTML instead of a browser-
 * normalized DOM line. The pattern permits inline tags and whitespace between
 * words, so text such as "Our <strong>tools</strong> helps" stays traceable.
 */
export function locateTextLine(
  source: string,
  text: string,
  index: number,
  fallbackLine: number,
): number {
  const tail = text.slice(Math.max(0, index));
  const words = tail.match(/[A-Za-z][A-Za-z'’-]*/g)?.slice(0, 5) ?? [];
  if (!words.length) return fallbackLine;
  const separator = String.raw`(?:\s|<[^>]*>|&nbsp;)*`;
  const pattern = new RegExp(words.map(escapePattern).join(separator), "gi");
  const candidates = [...source.matchAll(pattern)];
  if (!candidates.length) {
    const tokenPattern = new RegExp(escapePattern(words[0]), "gi");
    candidates.push(...source.matchAll(tokenPattern));
  }
  if (!candidates.length) return fallbackLine;
  return candidates
    .map((match) => lineOf(source, match.index ?? 0))
    .sort((left, right) =>
      Math.abs(left - fallbackLine) - Math.abs(right - fallbackLine),
    )[0];
}

function mapSourceLines(source: string, document: Document) {
  const lines = new WeakMap<Element, number>();
  const occurrences = new Map<string, number>();
  const tagPattern = /<([a-z][\w:-]*)\b[^>]*>/gi;
  for (const match of source.matchAll(tagPattern)) {
    const tag = match[1].toLowerCase();
    const occurrence = occurrences.get(tag) || 0;
    occurrences.set(tag, occurrence + 1);
    const element = document.getElementsByTagName(tag).item(occurrence);
    if (element) lines.set(element, lineOf(source, match.index));
  }
  return lines;
}

/** Add source-line metadata to a safe audit copy without modifying user input. */
export function annotateSourceLines(source: string): string {
  const document = new DOMParser().parseFromString(source, "text/html");
  const lines = mapSourceLines(source, document);
  document.querySelectorAll("*").forEach((element) => {
    const line = lines.get(element);
    if (line) element.setAttribute("data-markupmind-line", String(line));
  });
  const doctype = /^\s*<!doctype html>/i.test(source) ? "<!DOCTYPE html>\n" : "";
  return `${doctype}${document.documentElement.outerHTML}`;
}

/** Extract complete rendered phrases from the DOM, preserving text split by inline tags. */
export function extractTextSegments(source: string): TextSegment[] {
  const document = new DOMParser().parseFromString(source, "text/html");
  const sourceLines = mapSourceLines(source, document);
  document.querySelectorAll(IGNORED_SELECTOR).forEach((element) => element.remove());
  const segments: TextSegment[] = [];
  const seen = new Set<string>();
  const groups = new Map<Element, string[]>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const value = node.textContent?.replace(/\s+/g, " ").trim();
    if (!value || !/[A-Za-z]{2}/.test(value)) continue;
    let container = node.parentElement;
    while (container && container !== document.body) {
      if (
        PHRASE_CONTAINERS.has(container.tagName) ||
        FALLBACK_CONTAINERS.has(container.tagName)
      ) {
        break;
      }
      container = container.parentElement;
    }
    if (!container || container === document.body) continue;
    groups.set(container, [...(groups.get(container) || []), value]);
  }

  for (const [element, parts] of groups) {
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    if (!/[A-Za-z]{4}/.test(text)) continue;
    const signature = `${element.tagName}:${text}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    let located: Element | null = element;
    while (located && !sourceLines.has(located)) located = located.parentElement;
    segments.push({ text, line: (located && sourceLines.get(located)) || 1 });
  }

  return segments;
}

export function findHighConfidenceGrammarIssues(text: string): GrammarFinding[] {
  const findings: GrammarFinding[] = [];
  const addMatches = (pattern: RegExp, create: (match: RegExpExecArray) => Omit<GrammarFinding, "index">) => {
    for (const match of text.matchAll(pattern)) findings.push({ ...create(match), index: match.index });
  };

  addMatches(/\b(a)\s+(apple|answer|idea|image|issue|element|error|option|example|application|email|hour|honest)\b/gi, (match) => ({ title: "冠詞使用錯誤", message: `「${match[2]}」以母音音素開頭，前面應使用 an。`, replacement: `an ${match[2]}` }));
  addMatches(/\b(an)\s+(user|university|unique|useful|website|page|button|form|report|component)\b/gi, (match) => ({ title: "冠詞使用錯誤", message: `「${match[2]}」以子音音素開頭，前面應使用 a。`, replacement: `a ${match[2]}` }));
  addMatches(/\b(we|you|they|these|those)\s+(is|was|has|does)\b/gi, (match) => {
    const replacements: Record<string, string> = { is: "are", was: "were", has: "have", does: "do" };
    return { title: "主詞與動詞不一致", message: `主詞「${match[1]}」應搭配複數動詞。`, replacement: `${match[1]} ${replacements[match[2].toLowerCase()]}` };
  });
  addMatches(/\b(he|she|it)\s+(are|were|have|do|don't)\b/gi, (match) => {
    const replacements: Record<string, string> = { are: "is", were: "was", have: "has", do: "does", "don't": "doesn't" };
    return { title: "主詞與動詞不一致", message: `主詞「${match[1]}」是第三人稱單數，動詞形式需要調整。`, replacement: `${match[1]} ${replacements[match[2].toLowerCase()]}` };
  });
  addMatches(/\b(this|that)\s+(are|were|have|do)\b/gi, (match) => {
    const replacements: Record<string, string> = { are: "is", were: "was", have: "has", do: "does" };
    return { title: "主詞與動詞不一致", message: `「${match[1]}」是單數指示詞，應搭配單數動詞。`, replacement: `${match[1]} ${replacements[match[2].toLowerCase()]}` };
  });
  addMatches(/\bthere\s+(is|was)\s+(many|several|multiple|two|three|four|five|six|seven|eight|nine|ten)\b/gi, (match) => ({ title: "單複數搭配錯誤", message: `「${match[2]}」表示複數，there 後面應使用複數動詞。`, replacement: `there ${match[1].toLowerCase() === "is" ? "are" : "were"} ${match[2]}` }));
  addMatches(/\b(can|could|may|might|must|should|will|would)\s+(runs|provides|supports|includes|offers|allows|helps|works|needs|has|does|goes)\b/gi, (match) => ({ title: "情態動詞後的動詞形式錯誤", message: `情態動詞「${match[1]}」後面應使用原形動詞。`, replacement: `${match[1]} ${{ has: "have", does: "do", goes: "go" }[match[2].toLowerCase()] || match[2].replace(/s$/i, "")}` }));
  addMatches(/\blook(?:s|ed|ing)?\s+forward\s+to\s+(meet|see|hear|work|receive|discuss)\b/gi, (match) => ({ title: "動名詞形式錯誤", message: "「look forward to」後面應接名詞或動名詞（-ing）。", replacement: match[0].replace(new RegExp(`${match[1]}$`, "i"), ({ meet: "meeting", see: "seeing", hear: "hearing", work: "working", receive: "receiving", discuss: "discussing" } as Record<string, string>)[match[1].toLowerCase()]) }));
  addMatches(/\b(the|this|that|our)\s+(device|system|product|application|computer|display|feature|solution|platform|software)\s+(provide|support|include|offer|allow|help|work|need)\b/gi, (match) => ({ title: "主詞與動詞不一致", message: `單數主詞「${match[2]}」應搭配第三人稱單數動詞。`, replacement: `${match[1]} ${match[2]} ${match[3]}s` }));
  addMatches(/\b([a-z]+)\s+\1\b/gi, (match) => ({ title: "英文單字重複", message: `「${match[1]}」連續出現兩次，通常只需保留一次。`, replacement: match[1] }));
  addMatches(/\b(could|should|would|must)\s+of\b/gi, (match) => ({ title: "助動詞片語錯誤", message: `「${match[1]} of」應改為「${match[1]} have」。`, replacement: `${match[1]} have` }));
  addMatches(/\b(more|most)\s+(better|best|worse|worst|easier|easiest|faster|fastest)\b/gi, (match) => ({ title: "比較級重複", message: `「${match[2]}」本身已是比較級或最高級，不需再加 ${match[1]}。`, replacement: match[2] }));
  addMatches(/\b(build|create|design|make)\s+(better\s+|new\s+|simple\s+|responsive\s+)?(website|page|application|form|button|component|report)\b/gi, (match) => ({ title: "可數名詞缺少冠詞", message: `單數可數名詞「${match[3]}」前通常需要 a、an 或 the。`, replacement: `${match[1]} a ${match[2] || ""}${match[3]}` }));
  addMatches(/\bsave your time\b/gi, () => ({ title: "英文用字不自然", message: "若要表達節省使用者時間，建議使用「save you time」。", replacement: "save you time" }));
  return findings;
}

const DOMAIN_WORDS = new Set([
  "dtresearch", "intel", "nvidia", "qualcomm", "windows", "android", "bluetooth", "wifi", "ethernet",
  "rugged", "medical", "tablet", "tablets", "touchscreen", "fanless", "healthcare", "workstation",
  "photoswipe", "lightbox", "webpage", "datasheet", "middleware", "firmware", "barcode", "webcam",
  "luminance", "brightness", "backlight", "grayscale", "colorimeter", "touchscreen", "viewing", "nits",
  "fischer", "minimax", "microsd", "welch", "allyn",
]);

function editDistance(left: string, right: string) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[b.length];
}

export function isActionableSpelling(token: string, replacement: string) {
  const word = token.trim();
  const suggestion = replacement.trim();
  if (!/^[A-Za-z]{4,}$/.test(word) || !/^[A-Za-z]{4,}$/.test(suggestion)) return false;
  if (DOMAIN_WORDS.has(word.toLowerCase())) return false;
  if (word === word.toUpperCase()) return false;
  if (word[0].toLowerCase() !== suggestion[0].toLowerCase()) return false;
  const allowedDistance = word.length >= 9 ? 2 : 1;
  return editDistance(word, suggestion) <= allowedDistance;
}

const FINITE_VERB_PATTERN =
  /\b(?:am|is|are|was|were|be|been|being|has|have|had|do|does|did|provides?|supports?|includes?|features?|offers?|allows?|helps?|works?|needs?|saves?|uses?|delivers?|enables?|can|could|may|might|must|shall|should|will|would)\b/i;

/** Product-spec lists and headings are phrases, not sentences to grammar-correct. */
export function getSegmentLintMode(text: string): "spelling" | "full" | "skip" {
  const normalized = text.replace(/\s+/g, " ").trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  if (!/[A-Za-z]{4}/.test(normalized)) return "skip";
  const looksLikeSpecificationList =
    (normalized.match(/,/g)?.length ?? 0) >= 2 &&
    !FINITE_VERB_PATTERN.test(normalized);
  const looksLikeHeading =
    !/[.!?]$/.test(normalized) && !FINITE_VERB_PATTERN.test(normalized);
  return words.length <= 5 || looksLikeSpecificationList || looksLikeHeading
    ? "spelling"
    : "full";
}

const PROTECTED_PRODUCT_WORDS =
  /\b(?:intel|core|nvidia|geforce|quadro|qualcomm|snapdragon|windows|android|bluetooth|wi-?fi|ethernet|thunderbolt|photoswipe|dtresearch)\b/gi;

const VERIFIED_BRAND_PHRASES = [
  "Welch Allyn",
  "Fischer MiniMax",
] as const;

const escapeBrandPhrase = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const VERIFIED_BRAND_PATTERN = new RegExp(
  `\\b(?:${VERIFIED_BRAND_PHRASES.map(escapeBrandPhrase).join("|")})\\b`,
  "gi",
);

const MULTIWORD_PROPER_NOUN_PATTERN =
  /\b[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)+\b/g;

/** Hide brands, trademarks and model tokens without changing lint offsets. */
export function maskProtectedProductText(text: string): string {
  return text
    .replace(VERIFIED_BRAND_PATTERN, (token) => " ".repeat(token.length))
    .replace(MULTIWORD_PROPER_NOUN_PATTERN, (token) => " ".repeat(token.length))
    .replace(PROTECTED_PRODUCT_WORDS, (token) => " ".repeat(token.length))
    .replace(/\b[A-Za-z]*[a-z][A-Z][A-Za-z]*\b/g, (token) => " ".repeat(token.length))
    .replace(/[®™©]/g, " ")
    .replace(/\b[A-Z]{2,}[A-Za-z0-9-]*\b/g, (token) => " ".repeat(token.length))
    .replace(/\b[A-Za-z]*\d[A-Za-z0-9/-]*\b/g, (token) => " ".repeat(token.length))
    .replace(/\b[A-Za-z]+(?:-[A-Za-z0-9]+)+\b/g, (token) => " ".repeat(token.length));
}

export function isSafeGrammarSuggestion(
  original: string,
  replacement: string,
  kind: string,
  lintMode: "spelling" | "full",
): boolean {
  if (!original.trim() || !replacement.trim()) return false;
  if (kind === "Spelling") return isActionableSpelling(original, replacement);
  if (lintMode !== "full") return false;
  if (kind !== "Punctuation" && !/^[A-Za-z0-9"'(]/.test(replacement.trim())) {
    return false;
  }
  return true;
}

export type CategoryRating = { category: IssueCategory; label: string; grade: "A" | "B" | "C" | "D" | "E"; issueCount: number };

export function getCategoryRatings(issues: QualityIssue[]): CategoryRating[] {
  const labels: Record<IssueCategory, string> = { html: "HTML 結構", grammar: "英文內容", seo: "SEO", accessibility: "無障礙" };
  return (Object.keys(labels) as IssueCategory[]).map((category) => {
    const categoryIssues = issues.filter((issue) => issue.type === category);
    const penalty = categoryIssues.reduce((sum, issue) => sum + (issue.severity === "error" ? 3 : issue.severity === "warning" ? 2 : 1), 0);
    const grade = penalty === 0 ? "A" : penalty <= 2 ? "B" : penalty <= 5 ? "C" : penalty <= 9 ? "D" : "E";
    return { category, label: labels[category], grade, issueCount: categoryIssues.length };
  });
}

export type ReportIssue = QualityIssue & {
  title: string;
  message: string;
  line: number;
  replacement?: string;
};

export function buildQualityReport<T extends ReportIssue>(issues: T[]) {
  const highPriority = issues.filter((issue) => issue.severity === "error");
  const english = issues.filter((issue) => issue.type === "grammar" && issue.severity !== "error");
  const html = issues.filter((issue) => issue.type === "html" && issue.severity !== "error");
  const seo = issues.filter((issue) => issue.type === "seo" && issue.severity !== "error");
  const accessibility = issues.filter((issue) => issue.type === "accessibility" && issue.severity !== "error");
  const verdict = highPriority.length
    ? "目前不建議直接發布"
    : issues.length
      ? "建議完成修正後再發布"
      : "未發現阻擋發布的問題";
  return { highPriority, english, html, seo, accessibility, verdict };
}
