"use client";

import { useEffect, useRef, useState } from "react";
import { HtmlValidate } from "html-validate/browser";
import { Dialect, WorkerLinter } from "harper.js";
import { binaryInlined } from "harper.js/binaryInlined";

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
      add({
        type: accessibility ? "accessibility" : "html",
        severity: message.severity === 2 ? "error" : "warning",
        title: message.ruleId.replaceAll("-", " "),
        message: message.message,
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
      add({
        type: "grammar",
        severity: "warning",
        title: lint.lint_kind_pretty(),
        message: lint.message(),
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
        <div className="brand"><span className="brand-mark">✓</span><span>Markup<span>Mind</span></span></div>
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
          <div className="code-wrap">
            <div className="line-nums" aria-hidden>{code.split("\n").map((_, i) => <span key={i}>{i + 1}</span>)}</div>
            <textarea aria-label="HTML 原始碼" spellCheck={false} value={code} onChange={(e) => {setCode(e.target.value); setChecked(false);}} />
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

      <footer><span>MarkupMind · HTML quality, made clear.</span><span>HTML 結構　·　英文文法　·　無障礙設計</span></footer>
      <button className="back-to-top" aria-label="回到頁面頂端" title="回到頂端" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>↑</button>
    </main>
  );
}
