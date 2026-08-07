"use client";

import { useEffect, useRef, useState } from "react";
import { HtmlValidate } from "html-validate/browser";
import { Dialect, WorkerLinter } from "harper.js";
import { binaryInlined } from "harper.js/binaryInlined";
import { dtrLogo } from "./dtr-logo";

type Issue = {
  id: string;
  type: "html" | "grammar" | "accessibility";
  severity: "error" | "warning" | "suggestion";
  title: string;
  message: string;
  line: number;
  excerpt: string;
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

function analyse(source: string): Issue[] {
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
        add({ type: "grammar", severity: "warning", title: rule.title, message: rule.msg, line, excerpt: excerptAt(source, line), replacement });
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

  const masked = source
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, (block) => block.replace(/[^\n]/g, " "))
    .replace(/<!--[\s\S]*?-->/g, (block) => block.replace(/[^\n]/g, " "));
  const textSegments = [...masked.matchAll(/>([^<>]+)</g)]
    .map((match) => ({ raw: match[1], offset: (match.index || 0) + 1 }))
    .filter(({ raw }) => /[A-Za-z]{2}/.test(raw) && raw.trim().split(/\s+/).length >= 2);
  const linter = await getGrammarLinter();

  for (const segment of textSegments) {
    const decoded = new DOMParser().parseFromString(`<body>${segment.raw}</body>`, "text/html").body.textContent || segment.raw;
    const lints = await linter.lint(decoded, { language: "plaintext", isolateEnglish: true });
    for (const lint of lints) {
      const span = lint.span();
      const suggestions = lint.suggestions();
      const line = lineOf(source, segment.offset + Math.min(span.start, segment.raw.length));
      const translated = translateGrammarIssue(lint.lint_kind_pretty(), lint.message());
      add({
        type: "grammar",
        severity: "warning",
        title: translated.title,
        message: translated.message,
        line,
        excerpt: excerptAt(source, line),
        replacement: suggestions[0]?.get_replacement_text(),
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
  const [filter, setFilter] = useState<"all" | Issue["type"]>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [fontScale, setFontScale] = useState<90 | 100 | 110>(100);
  const fileInput = useRef<HTMLInputElement>(null);
  const visible = filter === "all" ? issues : issues.filter((issue) => issue.type === filter);
  const score = Math.max(0, 100 - issues.reduce((sum, issue) => sum + (issue.severity === "error" ? 12 : issue.severity === "warning" ? 6 : 3), 0));

  useEffect(() => {
    const savedTheme = localStorage.getItem("markupmind-theme") as "light" | "dark" | null;
    const savedScale = Number(localStorage.getItem("markupmind-font-scale"));
    const initialTheme = savedTheme || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setTheme(initialTheme);
    if (savedScale === 90 || savedScale === 100 || savedScale === 110) setFontScale(savedScale);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("markupmind-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("markupmind-font-scale", String(fontScale));
  }, [fontScale]);

  const runCheck = async (source = code) => {
    setChecking(true);
    setSelected(null);
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
    await navigator.clipboard.writeText(issues.map((x) => `[${x.severity.toUpperCase()}] Line ${x.line}: ${x.title} — ${x.message}`).join("\n"));
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
        <h1>讓每一行程式碼，<br/><em>說正確的話。</em></h1>
        <p className="subhead">一次找出 HTML 結構、無障礙與英文文法問題。<br/>檔案只在您的裝置上分析，不會上傳。</p>
      </section>

      <section className="workspace">
        <div className="editor-panel">
          <div className="panel-head">
            <div><span className="file-icon">&lt;/&gt;</span><strong>HTML 原始碼</strong><span className="file-name">index.html</span></div>
            <button className="upload" onClick={() => fileInput.current?.click()}>↑ 上傳 .html</button>
            <input ref={fileInput} type="file" accept=".html,.htm,text/html" hidden onChange={(e) => handleFile(e.target.files?.[0])}/>
          </div>
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
          <div className="score-row">
            <div className={`score score-${score < 70 ? "low" : "good"}`}><strong>{score}</strong><small>/100</small></div>
            <div><strong>{checking ? "正在全面分析" : checked ? (issues.length ? "需要一些調整" : "看起來很棒！") : "等待完整檢查"}</strong><p>{checking ? "檢查 HTML5 規則與英文文法…" : checked ? `找到 ${issues.length} 個可改善項目` : "按下按鈕開始分析"}</p></div>
          </div>
          <div className="filters">
            {(["all", "html", "grammar", "accessibility"] as const).map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "all" ? "全部" : item === "grammar" ? "英文" : item === "accessibility" ? "無障礙" : "HTML"}<span>{item === "all" ? issues.length : issues.filter((x) => x.type === item).length}</span></button>)}
          </div>
          <div className="issue-list">
            {!checked && <div className="empty">按下「執行檢查」以更新分析結果。</div>}
            {checked && visible.length === 0 && <div className="empty">這個分類沒有發現問題。</div>}
            {visible.map((issue) => <button key={issue.id} className={`issue ${selected === issue.id ? "selected" : ""}`} onClick={() => setSelected(selected === issue.id ? null : issue.id)}>
              <span className={`severity ${issue.severity}`}>{issue.severity === "error" ? "!" : issue.severity === "warning" ? "△" : "i"}</span>
              <span className="issue-body"><span className="issue-top"><strong>{issue.title}</strong><small>第 {issue.line} 行</small></span><span>{issue.message}</span>{selected === issue.id && <span className="detail"><code>{issue.excerpt}</code>{issue.replacement && <><small>建議</small><code className="replacement">{issue.replacement}</code></>}</span>}</span>
              <span className="chevron">›</span>
            </button>)}
          </div>
          <div className="results-foot"><button onClick={copyReport} disabled={!issues.length}>複製檢查報告</button><span>本機分析 · 無資料上傳</span></div>
        </aside>
      </section>

      <footer><span>網頁大師 · HTML quality, made clear.</span><span>Designed by Andy Lee</span><span>HTML 結構　·　英文文法　·　無障礙設計</span></footer>
      <button className="back-to-top" aria-label="回到頁面頂端" title="回到頂端" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>↑</button>
    </main>
  );
}