"use client";

import { useEffect, useRef, useState } from "react";
import { HtmlValidate } from "html-validate/browser";
import { Dialect, WorkerLinter } from "harper.js";
import { binaryInlined } from "harper.js/binaryInlined";
import axe from "axe-core";
import { dtrLogo } from "./dtr-logo";
import { annotateSourceLines, buildQualityReport, extractSentenceAt, extractTextSegments, findHighConfidenceGrammarIssues as findGrammarIssues, getCategoryRatings, getSegmentLintMode, isSafeGrammarSuggestion, locateTextLine, maskProtectedProductText } from "./quality";

type Issue = {
  id: string;
  type: "html" | "grammar" | "seo" | "accessibility";
  severity: "error" | "warning" | "suggestion";
  title: string;
  message: string;
  line: number;
  excerpt: string;
  sentence?: string;
  replacement?: string;
};

const sample = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Our product</title>
</head>
<body>
  <main>
    <h1>Build better website</h1>
    <img src="dashboard.png">
    <p>Our tools helps your team move faster.</p>
    <p>It is easy to use and save your time.</p>
    <a href="/start">click here</a>
  </main>
</body>
</html>`;

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;
const excerptAt = (source: string, line: number) => source.split("\n")[line - 1]?.trim() || "";

const htmlRuleTranslations: Record<string, { title: string; message: string }> = {
  "area-alt": { title: "圖片熱區缺少替代文字", message: "請為圖片熱區加入 alt，讓輔助工具能說明連結用途。" },
  "attribute-allowed-values": { title: "屬性值不正確", message: "此屬性使用了不支援的值，請改用該 HTML 元素允許的值。" },
  "attribute-misuse": { title: "屬性使用位置不正確", message: "這個屬性不適合目前的 HTML 元素，請移除或移至正確元素。" },
  "close-attr": { title: "屬性未正確結束", message: "屬性的引號或結尾不完整，請檢查這一行的屬性寫法。" },
  "close-order": { title: "標籤關閉順序錯誤", message: "HTML 標籤必須依巢狀順序關閉，請先關閉最內層的標籤。" },
  "doctype-html": { title: "DOCTYPE 宣告不正確", message: "文件開頭應使用 <!DOCTYPE html> 宣告 HTML5。" },
  "element-name": { title: "HTML 元素名稱無效", message: "此標籤名稱不是有效的 HTML 元素，請確認是否拼錯。" },
  "element-permitted-content": { title: "元素內容不允許", message: "此元素不能放在目前的父元素內，請調整 HTML 巢狀結構。" },
  "element-permitted-occurrences": { title: "元素出現次數不正確", message: "此元素在目前位置出現過多次，請移除重複內容。" },
  "element-permitted-order": { title: "元素排列順序不正確", message: "此元素必須依 HTML 規範放在其他指定元素之前或之後。" },
  "element-required-attributes": { title: "缺少必要屬性", message: "此元素缺少必要屬性；請補上，以確保內容及輔助工具能正確使用。" },
  "element-required-content": { title: "缺少必要的子元素", message: "此元素內必須包含指定的內容，請補上必要的子元素。" },
  "heading-level": { title: "標題層級跳號", message: "請依序使用標題層級，避免直接跨越層級，讓頁面結構更清楚。" },
  "input-missing-label": { title: "表單欄位缺少標籤", message: "請使用 label 或適當的無障礙名稱說明此輸入欄位。" },
  "missing-doctype": { title: "缺少 DOCTYPE", message: "請在文件第一行加入 <!DOCTYPE html>。" },
  "no-dup-attr": { title: "屬性重複", message: "同一元素不可重複使用相同屬性，請保留正確的一個。" },
  "no-dup-id": { title: "ID 重複", message: "頁面中的 id 必須是唯一值，請更改其中一個 id。" },
  "no-implicit-close": { title: "標籤被隱含關閉", message: "請明確補上結束標籤，避免瀏覽器誤解文件結構。" },
  "no-missing-references": { title: "參照目標不存在", message: "屬性引用的 id 在頁面中不存在，請確認目標名稱。" },
  "no-redundant-role": { title: "重複的 ARIA 角色", message: "此元素本身已有相同語意，不需要再指定這個 role。" },
  "no-unknown-elements": { title: "未知的 HTML 元素", message: "瀏覽器無法辨識此標籤，請確認元素名稱是否拼寫正確。" },
  "unique-landmark": { title: "頁面地標名稱重複", message: "相同類型的頁面地標應有可區分的無障礙名稱。" },
  "valid-autocomplete": { title: "自動完成屬性無效", message: "請為 autocomplete 使用瀏覽器支援的有效值。" },
  "void-content": { title: "空元素含有不允許的內容", message: "此 HTML 元素不能包含內容或結束標籤，請修正標記。" },
};

function translateHtmlIssue(ruleId: string) {
  return htmlRuleTranslations[ruleId] || { title: "HTML 語法需要調整", message: `第 ${ruleId} 項規則未通過，請檢查此行的標籤、屬性與巢狀結構。` };
}

function translateGrammarIssue(kind: string, message: string) {
  const value = `${kind} ${message}`.toLowerCase();
  if (/article|determiner|\ba\b.*\ban\b/.test(value)) return { title: "冠詞使用可能不正確", message: "請確認可數名詞前的 a、an 或 the 是否符合語意與發音。" };
  if (/subject|verb|agreement/.test(value)) return { title: "主詞與動詞可能不一致", message: "請確認動詞形式與主詞的單複數及人稱一致。" };
  if (/plural|singular|noun number/.test(value)) return { title: "名詞單複數可能不正確", message: "請依句意確認名詞應使用單數或複數形式。" };
  if (/spelling|misspell|typo/.test(value)) return { title: "英文拼字可能有誤", message: "此單字可能拼寫錯誤，請參考下方建議內容。" };
  if (/capital|case/.test(value)) return { title: "英文大小寫需要調整", message: "請確認句首、專有名詞或縮寫的大小寫。" };
  if (/punctuation|comma|period|apostrophe|quote/.test(value)) return { title: "英文標點需要調整", message: "此處的標點符號可能遺漏、重複或位置不正確。" };
  if (/repeat|duplicate/.test(value)) return { title: "英文單字重複", message: "此處可能出現不必要的重複單字，建議刪除其中一個。" };
  if (/word choice|usage|confus|homophone/.test(value)) return { title: "英文用字可能不適合", message: "此字詞可能不符合句意，請參考下方建議內容。" };
  return { title: "英文文法需要調整", message: "偵測到可能的英文文法或用字問題，請參考下方建議內容修正。" };
}

type GrammarFinding = Pick<Issue, "title" | "message" | "replacement"> & { index: number };

export function findHighConfidenceGrammarIssues(text: string): GrammarFinding[] {
  const findings: GrammarFinding[] = [];
  const addMatches = (
    pattern: RegExp,
    create: (match: RegExpExecArray) => Omit<GrammarFinding, "index">,
  ) => {
    for (const match of text.matchAll(pattern)) findings.push({ ...create(match), index: match.index });
  };

  addMatches(/\b(a)\s+(apple|answer|idea|image|issue|element|error|option|example|application|email|hour|honest)\b/gi, (match) => ({
    title: "冠詞使用錯誤",
    message: `「${match[2]}」以母音音素開頭，前面應使用 an。`,
    replacement: `an ${match[2]}`,
  }));
  addMatches(/\b(an)\s+(user|university|unique|useful|website|page|button|form|report|component)\b/gi, (match) => ({
    title: "冠詞使用錯誤",
    message: `「${match[2]}」以子音音素開頭，前面應使用 a。`,
    replacement: `a ${match[2]}`,
  }));
  addMatches(/\b(we|you|they|these|those)\s+(is|was|has|does)\b/gi, (match) => {
    const replacements: Record<string, string> = { is: "are", was: "were", has: "have", does: "do" };
    return {
      title: "主詞與動詞不一致",
      message: `主詞「${match[1]}」應搭配複數動詞。`,
      replacement: `${match[1]} ${replacements[match[2].toLowerCase()]}`,
    };
  });
  addMatches(/\b(he|she|it)\s+(are|were|have|do|don't)\b/gi, (match) => {
    const replacements: Record<string, string> = { are: "is", were: "was", have: "has", do: "does", "don't": "doesn't" };
    return {
      title: "主詞與動詞不一致",
      message: `主詞「${match[1]}」是第三人稱單數，動詞形式需要調整。`,
      replacement: `${match[1]} ${replacements[match[2].toLowerCase()]}`,
    };
  });
  addMatches(/\b(this|that)\s+(are|were|have|do)\b/gi, (match) => {
    const replacements: Record<string, string> = { are: "is", were: "was", have: "has", do: "does" };
    return {
      title: "主詞與動詞不一致",
      message: `「${match[1]}」是單數指示詞，應搭配單數動詞。`,
      replacement: `${match[1]} ${replacements[match[2].toLowerCase()]}`,
    };
  });
  addMatches(/\b(our|their|these|those)\s+([a-z]+s)\s+(helps|needs|makes|works|provides|allows|supports|is|has|does)\b/gi, (match) => {
    const replacements: Record<string, string> = { is: "are", has: "have", does: "do" };
    const verb = match[3].toLowerCase();
    return {
      title: "主詞與動詞不一致",
      message: `複數主詞「${match[2]}」應搭配原形或複數動詞。`,
      replacement: `${match[1]} ${match[2]} ${replacements[verb] || verb.replace(/s$/, "")}`,
    };
  });
  addMatches(/\bthere\s+(is|was)\s+([a-z]+s)\b/gi, (match) => ({
    title: "單複數搭配錯誤",
    message: `「${match[2]}」是複數名詞，there 後面應使用複數動詞。`,
    replacement: `there ${match[1].toLowerCase() === "is" ? "are" : "were"} ${match[2]}`,
  }));
  addMatches(/\bthere\s+(is|was)\s+(many|several|multiple|two|three|four|five|six|seven|eight|nine|ten)\b/gi, (match) => ({
    title: "單複數搭配錯誤",
    message: `「${match[2]}」表示複數，there 後面應使用複數動詞。`,
    replacement: `there ${match[1].toLowerCase() === "is" ? "are" : "were"} ${match[2]}`,
  }));
  addMatches(/\b(can|could|may|might|must|should|will|would)\s+(runs|provides|supports|includes|offers|allows|helps|works|needs|has|does|goes)\b/gi, (match) => ({
    title: "情態動詞後的動詞形式錯誤",
    message: `情態動詞「${match[1]}」後面應使用原形動詞。`,
    replacement: `${match[1]} ${{ has: "have", does: "do", goes: "go" }[match[2].toLowerCase()] || match[2].replace(/s$/i, "")}`,
  }));
  addMatches(/\blook(?:s|ed|ing)?\s+forward\s+to\s+(meet|see|hear|work|receive|discuss)\b/gi, (match) => ({
    title: "動名詞形式錯誤",
    message: "「look forward to」後面應接名詞或動名詞（-ing）。",
    replacement: match[0].replace(new RegExp(`${match[1]}$`, "i"), ({ meet: "meeting", see: "seeing", hear: "hearing", work: "working", receive: "receiving", discuss: "discussing" } as Record<string, string>)[match[1].toLowerCase()]),
  }));
  addMatches(/\b(the|this|that|our)\s+(device|system|product|application|computer|display|feature|solution|platform|software)\s+(provide|support|include|offer|allow|help|work|need)\b/gi, (match) => ({
    title: "主詞與動詞不一致",
    message: `單數主詞「${match[2]}」應搭配第三人稱單數動詞。`,
    replacement: `${match[1]} ${match[2]} ${match[3] === "have" ? "has" : `${match[3]}s`}`,
  }));
  addMatches(/\b([a-z]+)\s+\1\b/gi, (match) => ({
    title: "英文單字重複",
    message: `「${match[1]}」連續出現兩次，通常只需保留一次。`,
    replacement: match[1],
  }));
  addMatches(/\b(could|should|would|must)\s+of\b/gi, (match) => ({
    title: "助動詞片語錯誤",
    message: `「${match[1]} of」應改為「${match[1]} have」。`,
    replacement: `${match[1]} have`,
  }));
  addMatches(/\b(more|most)\s+(better|best|worse|worst|easier|easiest|faster|fastest)\b/gi, (match) => ({
    title: "比較級重複",
    message: `「${match[2]}」本身已是比較級或最高級，不需再加 ${match[1]}。`,
    replacement: match[2],
  }));
  addMatches(/\b(build|create|design|make)\s+(better\s+|new\s+|simple\s+|responsive\s+)?(website|page|application|form|button|component|report)\b/gi, (match) => ({
    title: "可數名詞缺少冠詞",
    message: `單數可數名詞「${match[3]}」前通常需要 a、an 或 the。`,
    replacement: `${match[1]} a ${match[2] || ""}${match[3]}`,
  }));
  addMatches(/\bsave your time\b/gi, () => ({
    title: "英文用字不自然",
    message: "「save your time」通常表示保留時間；若要表達節省使用者時間，建議改用「save you time」。",
    replacement: "save you time",
  }));

  return findings;
}

export function analyse(source: string): Issue[] {
  const issues: Issue[] = [];
  const add = (issue: Omit<Issue, "id">) => issues.push({ ...issue, id: `${issue.type}-${issue.line}-${issues.length}` });

  if (!/^\s*<!doctype html>/i.test(source)) {
    add({ type: "html", severity: "error", title: "缺少 DOCTYPE", message: "文件開頭應宣告 HTML5 DOCTYPE。", line: 1, excerpt: excerptAt(source, 1), replacement: "<!DOCTYPE html>" });
  }
  const htmlTag = source.match(/<html\b[^>]*>/i);
  if (htmlTag && !/\blang\s*=/.test(htmlTag[0])) {
    const line = lineOf(source, htmlTag.index || 0);
    add({ type: "accessibility", severity: "warning", title: "未指定頁面語言", message: "在 <html> 加入 lang，幫助螢幕閱讀器正確發音。", line, excerpt: excerptAt(source, line), replacement: '<html lang="en">' });
  }
  if (!/<meta\s+[^>]*charset\s*=/i.test(source)) {
    add({ type: "html", severity: "warning", title: "缺少字元編碼", message: "建議在 <head> 中加入 UTF-8 字元編碼。", line: 2, excerpt: "<head>", replacement: '<meta charset="UTF-8">' });
  }
  if (!/<title>[^<]+<\/title>/i.test(source)) {
    add({ type: "html", severity: "warning", title: "缺少頁面標題", message: "每個頁面都需要清楚、獨特的 <title>。", line: 2, excerpt: "<head>", replacement: "<title>Page title</title>" });
  }

  for (const match of source.matchAll(/<img\b[^>]*>/gi)) {
    if (!/\balt\s*=/.test(match[0])) {
      const line = lineOf(source, match.index || 0);
      add({ type: "accessibility", severity: "error", title: "圖片缺少替代文字", message: "為有意義的圖片加入 alt；裝飾圖片可使用空白 alt。", line, excerpt: excerptAt(source, line), replacement: match[0].replace(/>$/, ' alt="Describe this image">') });
    }
  }
  for (const match of source.matchAll(/<a\b[^>]*>(\s*(click here|read more|learn more)\s*)<\/a>/gi)) {
    const line = lineOf(source, match.index || 0);
    add({ type: "accessibility", severity: "suggestion", title: "連結文字不夠明確", message: "連結離開上下文後仍應說明目的。", line, excerpt: excerptAt(source, line), replacement: match[0].replace(match[1], "Get started") });
  }

  const textParts = [...source.matchAll(/>([^<>]+)</g)];
  const grammarRules = [
    { re: /\b(a) ([aeiou][a-z]+)/gi, title: "冠詞可能使用錯誤", msg: "母音音素開頭的單字前通常使用 “an”。", fix: (_: string, _a: string, word: string) => `an ${word}` },
    { re: /\b(an) ([^aeiou\W][a-z]+)/gi, title: "冠詞可能使用錯誤", msg: "子音音素開頭的單字前通常使用 “a”。", fix: (_: string, _a: string, word: string) => `a ${word}` },
    { re: /\b(Our|The) ([a-z]+s) helps\b/g, title: "主詞與動詞不一致", msg: "複數主詞應搭配原形動詞 “help”。", fix: (value: string) => value.replace(/helps$/, "help") },
    { re: /\b(It|This) (?:is )?easy to ([a-z]+) and ([a-z]+s)\b/g, title: "平行結構不一致", msg: "由 and 連接的動詞形式應保持一致。", fix: (value: string) => value.replace(/ and ([a-z]+)s$/, " and $1") },
    { re: /\bwebsite\b/gi, title: "名詞單複數可能不一致", msg: "此處若泛指可數項目，通常需要冠詞或複數形式。", fix: () => "websites" },
  ];
  for (const part of textParts) {
    const text = part[1];
    const base = (part.index || 0) + 1;
    for (const rule of grammarRules) {
      for (const match of text.matchAll(rule.re)) {
        const line = lineOf(source, base + (match.index || 0));
        const replacement = rule.fix(match[0], match[1], match[2]);
        add({ type: "grammar", severity: "warning", title: rule.title, message: rule.msg, line: locateTextLine(source, text, match.index || 0, line), excerpt: excerptAt(source, line), sentence: extractSentenceAt(text, match.index || 0), replacement });
      }
    }
  }

  const opens = (source.match(/<(div|section|main|article|p|h[1-6]|ul|ol|li)\b[^>]*>/gi) || []).length;
  const closes = (source.match(/<\/(div|section|main|article|p|h[1-6]|ul|ol|li)>/gi) || []).length;
  if (opens !== closes) add({ type: "html", severity: "error", title: "標籤可能未正確閉合", message: `偵測到 ${opens} 個開始標籤與 ${closes} 個結束標籤。`, line: source.split("\n").length, excerpt: excerptAt(source, source.split("\n").length) });
  return issues.sort((a, b) => a.line - b.line);
}

let grammarLinter: Promise<WorkerLinter> | null = null;

function getGrammarLinter() {
  if (!grammarLinter) {
    grammarLinter = (async () => {
      const linter = new WorkerLinter({ binary: binaryInlined, dialect: Dialect.American });
      await linter.setup();
      return linter;
    })();
  }
  return grammarLinter;
}

async function analyseDocument(source: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  const add = (issue: Omit<Issue, "id">) => issues.push({ ...issue, id: `${issue.type}-${issue.line}-${issues.length}` });
  const validator = new HtmlValidate({
    extends: ["html-validate:recommended", "html-validate:document"],
    rules: {
      "no-inline-style": "off",
      "prefer-native-element": "off",
      "require-sri": "off",
    },
  });
  const report = await validator.validateString(source, "index.html");

  for (const result of report.results) {
    for (const message of result.messages) {
      const accessibility = /^(element-required-attributes|wcag\/|prefer-native-element|heading-level|no-redundant-role|valid-autocomplete|input-missing-label|area-alt|svg-focusable|unique-landmark)$/.test(message.ruleId);
      const translated = translateHtmlIssue(message.ruleId);
      add({
        type: accessibility ? "accessibility" : "html",
        severity: message.severity === 2 ? "error" : "warning",
        title: translated.title,
        message: translated.message,
        line: message.line,
        excerpt: excerptAt(source, message.line),
      });
    }
  }

  const seoChecks = [
    { pattern: /<title\b[^>]*>[\s\S]*?<\/title>/gi, title: "缺少 SEO 頁面標題", message: "請加入唯一且能說明頁面內容的 <title>。", severity: "error" as const },
    { pattern: /<meta\s+[^>]*name=["']description["'][^>]*>/gi, title: "缺少 Meta Description", message: "請加入約 120–160 字元的頁面摘要。", severity: "warning" as const },
    { pattern: /<link\s+[^>]*rel=["']canonical["'][^>]*>/gi, title: "缺少 Canonical URL", message: "請加入 canonical，避免搜尋引擎判定為重複頁面。", severity: "warning" as const },
    { pattern: /<meta\s+[^>]*property=["']og:title["'][^>]*>/gi, title: "缺少 Open Graph 標題", message: "請加入 og:title，改善社群分享預覽。", severity: "suggestion" as const },
    { pattern: /<meta\s+[^>]*property=["']og:description["'][^>]*>/gi, title: "缺少 Open Graph 描述", message: "請加入 og:description，讓分享摘要更完整。", severity: "suggestion" as const },
    { pattern: /<meta\s+[^>]*property=["']og:image["'][^>]*>/gi, title: "缺少 Open Graph 圖片", message: "請加入完整 HTTPS 網址的 og:image。", severity: "suggestion" as const },
  ];
  for (const check of seoChecks) {
    const matches = [...source.matchAll(check.pattern)];
    if (!matches.length) add({ type: "seo", severity: check.severity, title: check.title, message: check.message, line: 1, excerpt: excerptAt(source, 1) });
  }
  const titles = [...source.matchAll(/<title\b[^>]*>[\s\S]*?<\/title>/gi)];
  for (const duplicate of titles.slice(1)) {
    const line = lineOf(source, duplicate.index);
    add({ type: "seo", severity: "error", title: "同一頁出現多個 <title>", message: "搜尋引擎無法判斷主要標題，請只保留一個 <title>。", line, excerpt: excerptAt(source, line) });
  }
  const h1s = [...source.matchAll(/<h1\b[^>]*>/gi)];
  if (!h1s.length) add({ type: "seo", severity: "warning", title: "缺少主要 H1 標題", message: "每個產品頁建議使用一個清楚的 H1。", line: 1, excerpt: excerptAt(source, 1) });
  if (h1s.length > 1) {
    const line = lineOf(source, h1s[1].index);
    add({ type: "seo", severity: "warning", title: "頁面包含多個 H1", message: "請確認主要內容階層，通常產品頁應只有一個主要 H1。", line, excerpt: excerptAt(source, line) });
  }

  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", left: "-10000px", top: "0", width: "1280px", height: "900px", opacity: "0", pointerEvents: "none" });
  frame.srcdoc = annotateSourceLines(source);
  document.body.appendChild(frame);
  try {
    await new Promise<void>((resolve) => {
      frame.addEventListener("load", () => resolve(), { once: true });
      window.setTimeout(resolve, 800);
    });
    const auditDocument = frame.contentDocument;
    if (auditDocument?.documentElement) {
      const audit = await axe.run(auditDocument.documentElement, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } });
      for (const violation of audit.violations) {
        for (const node of violation.nodes) {
          const selector = String(node.target[0] || "");
          const target = selector ? auditDocument.querySelector(selector) : null;
          const line = Number(target?.getAttribute("data-markupmind-line")) || 1;
          const impact = node.impact || violation.impact;
          add({
            type: "accessibility",
            severity: impact === "critical" || impact === "serious" ? "error" : impact === "moderate" ? "warning" : "suggestion",
            title: `無障礙：${violation.help}`,
            message: `${violation.description} ${node.failureSummary || ""}`.trim(),
            line,
            excerpt: excerptAt(source, line),
          });
        }
      }
    }
  } finally {
    frame.remove();
  }

  const textSegments = extractTextSegments(source);
  const linter = await getGrammarLinter();
  const grammarKeys = new Set<string>();
  // Technical product pages contain many valid brands, model numbers and acronyms.
  // Keep Harper in strict grammar-only mode so dictionary guesses never become advice.
  const reliableHarperKinds = new Set(["Agreement", "Eggcorn", "Grammar", "Malapropism", "Nonstandard", "Punctuation", "Repetition", "Spelling", "Usage", "WordChoice", "WordOrder"]);

  for (const segment of textSegments) {
    const decoded = segment.text;
    for (const finding of findGrammarIssues(decoded)) {
      const line = locateTextLine(source, decoded, finding.index, segment.line);
      const key = `${line}-${finding.title}-${finding.replacement || ""}`;
      if (grammarKeys.has(key)) continue;
      grammarKeys.add(key);
      add({
        type: "grammar",
        severity: "warning",
        title: finding.title,
        message: finding.message,
        line,
        excerpt: excerptAt(source, line),
        sentence: extractSentenceAt(decoded, finding.index),
        replacement: finding.replacement,
      });
    }

    const lintMode = getSegmentLintMode(decoded);
    if (lintMode === "skip" || (lintMode === "full" && !(await linter.isLikelyEnglish(decoded)))) continue;
    const grammarText = maskProtectedProductText(decoded);
    const lints = await linter.lint(grammarText, { language: "plaintext", isolateEnglish: lintMode === "full" });
    for (const lint of lints) {
      const span = lint.span();
      const suggestions = lint.suggestions();
      const kind = lint.lint_kind_pretty();
      const replacement = suggestions[0]?.get_replacement_text();
      const originalToken = grammarText.slice(span.start, span.end);
      const allowedKind = lintMode === "spelling" ? kind === "Spelling" : reliableHarperKinds.has(kind);
      if (!allowedKind || !replacement || !isSafeGrammarSuggestion(originalToken, replacement, kind, lintMode)) {
        suggestions.forEach((suggestion) => suggestion.free());
        span.free();
        lint.free();
        continue;
      }
      const line = locateTextLine(source, decoded, span.start, segment.line);
      const translated = translateGrammarIssue(kind, lint.message());
      const key = `${line}-${translated.title}-${replacement || ""}`;
      if (grammarKeys.has(key)) {
        suggestions.forEach((suggestion) => suggestion.free());
        span.free();
        lint.free();
        continue;
      }
      grammarKeys.add(key);
      add({
        type: "grammar",
        severity: "warning",
        title: translated.title,
        message: translated.message,
        line,
        excerpt: excerptAt(source, line),
        sentence: extractSentenceAt(decoded, span.start),
        replacement,
      });
      suggestions.forEach((suggestion) => suggestion.free());
      span.free();
      lint.free();
    }
  }

  return issues.sort((a, b) => a.line - b.line || (a.type === "html" ? -1 : 1));
}

export default function Home() {
  const [code, setCode] = useState(sample);
  const [checked, setChecked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [dragging, setDragging] = useState(false);
  const [resultTab, setResultTab] = useState<"overview" | Issue["type"]>("overview");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    return (localStorage.getItem("markupmind-theme") as "light" | "dark" | null) || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  });
  const [fontScale, setFontScale] = useState<90 | 100 | 110>(() => {
    if (typeof window === "undefined") return 100;
    const saved = Number(localStorage.getItem("markupmind-font-scale"));
    return saved === 90 || saved === 110 ? saved : 100;
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const ratings = getCategoryRatings(issues);
  const report = buildQualityReport(issues);
  const documentTitle = code.match(/<title\b[^>]*>([^<]+)<\/title>/i)?.[1].trim() || "HTML 文件";
  const tabIssues = resultTab === "overview" ? [] : issues.filter((issue) => issue.type === resultTab);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("markupmind-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("markupmind-font-scale", String(fontScale));
  }, [fontScale]);

  const runCheck = async (source = code) => {
    setChecking(true);
    setResultTab("overview");
    try {
      setIssues(await analyseDocument(source));
      setChecked(true);
    } finally {
      setChecking(false);
    }
  };

  const handleFile = async (file?: File) => {
    if (!file) return;
    if (!/\.html?$/i.test(file.name) && file.type !== "text/html") {
      window.alert("請選擇 .html 或 .htm 檔案。");
      return;
    }
    const source = await file.text();
    setCode(source);
    setChecked(false);
    await runCheck(source);
  };
  const copyReport = async () => {
    const table = (items: Issue[]) => items.map((item) => `| ${item.line} | ${item.title} | ${item.replacement || item.message} |`).join("\n") || "無";
    const bullets = (items: Issue[]) => items.map((item) => `- 第 ${item.line} 行：${item.title}${item.type === "grammar" && item.sentence ? `\n  - 錯誤句子：${item.sentence}` : ""}\n  - ${item.message}${item.replacement ? `\n  - 建議：${item.replacement}` : ""}`).join("\n") || "- 無";
    await navigator.clipboard.writeText(`檢查完成。這是 **${documentTitle}** 的 HTML 品質檢查報告，共發現 ${issues.length} 項需要確認。\n\n### 高優先問題\n\n| 行號 | 問題 | 建議 |\n| --- | --- | --- |\n${table(report.highPriority)}\n\n### HTML 結構\n\n${bullets(issues.filter((x) => x.type === "html"))}\n\n### 英文內容\n\n${bullets(issues.filter((x) => x.type === "grammar"))}\n\n### SEO\n\n${bullets(issues.filter((x) => x.type === "seo"))}\n\n### 無障礙\n\n${bullets(issues.filter((x) => x.type === "accessibility"))}\n\n整體判定：**${report.verdict}**。`);
  };

  return (
    <main className={`app-shell font-scale-${fontScale}`}>
      <header className="topbar">
        <div className="brand-area">
          <img className="dtr-logo" src={dtrLogo} alt="DT Research" />
          <span className="brand-divider" aria-hidden />
          <div className="brand"><span className="brand-mark">✓</span><span>網頁<span>大師</span></span></div>
        </div>
        <div className="header-actions">
          <div className="font-controls" aria-label="字體大小">
            <button aria-label="縮小字體" disabled={fontScale === 90} onClick={() => setFontScale(fontScale === 110 ? 100 : 90)}>A−</button>
            <span>{fontScale}%</span>
            <button aria-label="放大字體" disabled={fontScale === 110} onClick={() => setFontScale(fontScale === 90 ? 100 : 110)}>A＋</button>
          </div>
          <button className="theme-toggle" aria-label={`切換為${theme === "light" ? "深色" : "淺色"}模式`} onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
            <span aria-hidden>{theme === "light" ? "☾" : "☀"}</span>{theme === "light" ? "深色" : "淺色"}
          </button>
          <div className="privacy"><span className="dot" /> 在您的瀏覽器中安全檢查</div>
        </div>
      </header>

      <section className="hero">
        <p className="eyebrow">HTML + ENGLISH QUALITY CHECK</p>
        <p className="subhead">一次找出 HTML 結構、無障礙與英文文法問題。<br/>檔案只在您的裝置上分析，不會上傳。</p>
      </section>

      <section className="workspace">
        <div className="editor-panel">
          <div className="panel-head">
            <div><span className="file-icon">&lt;/&gt;</span><strong>HTML 原始碼</strong><span className="file-name">index.html</span></div>
            <button className="upload" onClick={() => fileInput.current?.click()}>選擇 HTML 檔案</button>
            <input ref={fileInput} type="file" accept=".html,.htm,text/html" hidden onChange={(e) => handleFile(e.target.files?.[0])}/>
          </div>
          <button
            className={`upload-guide ${dragging ? "is-dragging" : ""}`}
            onClick={() => fileInput.current?.click()}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragging(true); }}
            onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
            onDrop={(event) => { event.preventDefault(); setDragging(false); void handleFile(event.dataTransfer.files?.[0]); }}
          >
            <span className="upload-guide-icon" aria-hidden>⇧</span>
            <span className="upload-guide-copy"><strong>將 HTML 檔案拖曳到這裡</strong><small>或點此選擇檔案 · 支援 .html 與 .htm</small></span>
            <span className="upload-guide-action">瀏覽檔案</span>
          </button>
          <div
            className={`code-wrap ${dragging ? "is-dragging" : ""}`}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragging(true); }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
            onDrop={(event) => { event.preventDefault(); setDragging(false); void handleFile(event.dataTransfer.files?.[0]); }}
          >
            <div className="line-nums" aria-hidden>{code.split("\n").map((_, i) => <span key={i}>{i + 1}</span>)}</div>
            <textarea aria-label="HTML 原始碼" spellCheck={false} value={code} onChange={(e) => {setCode(e.target.value); setChecked(false);}} />
            {dragging && <div className="drop-overlay"><strong>放開以上傳 HTML</strong><span>支援 .html 與 .htm 檔案</span></div>}
          </div>
          <div className="editor-foot"><span>{code.split("\n").length} 行 · {new Blob([code]).size} bytes</span><button onClick={() => runCheck()} disabled={checking}>{checking ? "全面分析中…" : "執行完整檢查"} <span>→</span></button></div>
        </div>

        <aside className="results-panel">
          <div className="score-row ratings-row">
            <div className="ratings" aria-label="分項品質評級">
              {ratings.map((rating) => <div className={`rating grade-${rating.grade}`} key={rating.category}><strong>{rating.grade}</strong><span>{rating.label}</span><small>{rating.issueCount} 項</small></div>)}
            </div>
            <div className="rating-summary"><strong>{checking ? "正在全面分析" : checked ? (issues.length ? "需要一些調整" : "四項皆通過") : "等待完整檢查"}</strong><p>{checking ? "檢查 HTML5、英文、SEO 與 WCAG…" : checked ? `找到 ${issues.length} 個可改善項目` : "按下按鈕開始分析"}</p></div>
          </div>
          <div className="report-view">
            {!checked && <div className="empty">按下「執行完整檢查」以產生稽核報告。</div>}
            {checked && <>
              <p className="report-intro">檢查完成。這是 <strong>{documentTitle}</strong> 的 HTML 品質檢查報告，共發現 {issues.length} 項需要確認，包含 HTML 結構、英文內容、SEO 與無障礙問題。</p>
              <nav className="report-tabs" aria-label="檢查結果分類">{([{"key":"overview","label":"總覽"},{"key":"html","label":"HTML 結構"},{"key":"grammar","label":"英文內容"},{"key":"seo","label":"SEO"},{"key":"accessibility","label":"無障礙"}] as const).map((tab) => <button key={tab.key} className={resultTab === tab.key ? "active" : ""} onClick={() => setResultTab(tab.key)}>{tab.label}<span>{tab.key === "overview" ? issues.length : issues.filter((x) => x.type === tab.key).length}</span></button>)}</nav>
              {resultTab === "overview" ? <>
                <section className="report-section priority-section"><h2>高優先問題</h2>{report.highPriority.length ? <div className="report-table-wrap"><table className="report-table"><thead><tr><th>行號</th><th>問題</th><th>建議</th></tr></thead><tbody>{report.highPriority.map((issue) => <tr key={issue.id}><td>{issue.line}</td><td><strong>{issue.title}</strong><small>{issue.message}</small></td><td>{issue.replacement || issue.message}</td></tr>)}</tbody></table></div> : <p className="report-none">未發現高優先問題。</p>}</section>
                <p className={`report-verdict ${report.highPriority.length ? "blocked" : "clear"}`}>整體判定：<strong>{report.verdict}</strong>。</p>
              </> : <section className="report-section category-section"><h2>{resultTab === "html" ? "HTML 結構" : resultTab === "grammar" ? "英文內容" : resultTab === "seo" ? "SEO" : "無障礙"}</h2>{tabIssues.length ? <ul>{tabIssues.map((issue) => <li key={issue.id}><span>第 {issue.line} 行</span><strong>{issue.title}</strong>{issue.type === "grammar" && issue.sentence && <blockquote className="grammar-sentence"><small>錯誤句子</small>{issue.sentence}</blockquote>}<p>{issue.message}</p>{issue.replacement && <code>建議：{issue.replacement}</code>}</li>)}</ul> : <p className="report-none">此分類未發現問題。</p>}</section>}
            </>}
          </div>
          <div className="results-foot"><button onClick={copyReport} disabled={!issues.length}>複製檢查報告</button><span>本機分析 · 無資料上傳</span></div>
        </aside>
      </section>

      <footer><span>網頁大師 · HTML quality, made clear.</span><span>Designed by Andy Lee</span><span>HTML 結構 · 英文文法 · 無障礙設計</span></footer>
      <button className="back-to-top" aria-label="回到頁面頂端" title="回到頂端" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>↑</button>
    </main>
  );
}
