// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { annotateSourceLines, buildQualityReport, extractSentenceAt, extractTextSegments, findHighConfidenceGrammarIssues, getCategoryRatings, getSegmentLintMode, isActionableSpelling, locateTextLine } from "./quality";

describe("DOM-level visible text extraction", () => {
  it("keeps a sentence intact across inline markup", () => {
    const segments = extractTextSegments('<p>Our product <strong>helps</strong> users work faster.</p>');
    expect(segments).toEqual([{ text: "Our product helps users work faster.", line: 1 }]);
  });

  it("ignores scripts, styles, templates and hidden content", () => {
    const source = '<p>Visible product copy.</p><script>They is wrong.</script><p hidden>He are hidden.</p>';
    expect(extractTextSegments(source).map((item) => item.text)).toEqual(["Visible product copy."]);
  });

  it("tracks repeated elements to their exact source lines", () => {
    const source = '<p>First paragraph here.</p>\n<div>Layout</div>\n<p>Second <strong>paragraph</strong> here.</p>';
    expect(extractTextSegments(source)).toEqual([
      { text: "First paragraph here.", line: 1 },
      { text: "Layout", line: 2 },
      { text: "Second paragraph here.", line: 3 },
    ]);
  });

  it("annotates repeated audit targets with their original line", () => {
    const source = '<img src="first.png">\n<section>Content</section>\n<img src="second.png">';
    const audit = new DOMParser().parseFromString(annotateSourceLines(source), "text/html");
    expect([...audit.querySelectorAll("img")].map((img) => img.dataset.markupmindLine)).toEqual(["1", "3"]);
  });
});

describe("high-confidence English rules", () => {
  it.each([
    ["They is ready.", "They are"],
    ["It have a display.", "It has"],
    ["We should provides support.", "should provide"],
    ["This is more better.", "better"],
  ])("detects %s", (text, replacement) => {
    expect(findHighConfidenceGrammarIssues(text).some((finding) => finding.replacement?.toLowerCase().includes(replacement.toLowerCase()))).toBe(true);
  });

  it.each(["Our business helps customers.", "The news is important.", "This analysis works well."])("does not treat singular s-ending nouns as plural: %s", (text) => {
    expect(findHighConfidenceGrammarIssues(text)).toHaveLength(0);
  });
});

describe("actionable spelling filter", () => {
  it("accepts clear spelling corrections", () => {
    expect(isActionableSpelling("Enviromental", "Environmental")).toBe(true);
    expect(isActionableSpelling("peripherials", "peripherals")).toBe(true);
  });

  it("routes a one-word heading into spelling-only analysis", () => {
    const segments = extractTextSegments("<h2>Enviromental</h2>");
    expect(segments).toEqual([{ text: "Enviromental", line: 1 }]);
    expect(getSegmentLintMode(segments[0].text)).toBe("spelling");
  });

  it("routes the exact product-page heading into spelling-only analysis", () => {
    const segments = extractTextSegments("<h5><span>Mechanical and Enviromental</span><i></i></h5>");
    expect(segments).toEqual([{ text: "Mechanical and Enviromental", line: 1 }]);
    expect(getSegmentLintMode(segments[0].text)).toBe("spelling");
  });

  it("extracts a misspelled label from custom div and span markup", () => {
    const source = '<section class="spec"><div class="spec-title"><span>Enviromental</span></div></section>';
    expect(extractTextSegments(source)).toEqual([{ text: "Enviromental", line: 1 }]);
  });

  it("rejects model names, acronyms, and approved domain words", () => {
    expect(isActionableSpelling("DT373T", "DT373")).toBe(false);
    expect(isActionableSpelling("NVIS", "NIVS")).toBe(false);
    expect(isActionableSpelling("rugged", "ruggedly")).toBe(false);
    expect(isActionableSpelling("PhotoSwipe", "Photoswipe")).toBe(false);
    expect(isActionableSpelling("Luminance", "Dominance")).toBe(false);
    expect(isActionableSpelling("luminance", "luminescence")).toBe(false);
    expect(isActionableSpelling("Enviromental", "Environmental")).toBe(true);
  });
});

describe("category ratings", () => {
  it("rates each quality dimension independently", () => {
    const ratings = getCategoryRatings([
      { type: "html", severity: "error" },
      { type: "grammar", severity: "warning" },
      { type: "grammar", severity: "suggestion" },
    ]);
    expect(ratings.map(({ category, grade }) => [category, grade])).toEqual([
      ["html", "C"],
      ["grammar", "C"],
      ["seo", "A"],
      ["accessibility", "A"],
    ]);
  });
});

describe("structured quality report", () => {
  it("separates blocking, English, and structural findings", () => {
    const issue = (type: "html" | "grammar" | "seo" | "accessibility", severity: "error" | "warning", line: number) => ({ type, severity, line, title: "Test", message: "Test message" });
    const report = buildQualityReport([issue("html", "error", 2), issue("grammar", "warning", 4), issue("seo", "warning", 5), issue("accessibility", "warning", 6)]);
    expect(report.highPriority.map((item) => item.line)).toEqual([2]);
    expect(report.english.map((item) => item.line)).toEqual([4]);
    expect(report.seo.map((item) => item.line)).toEqual([5]);
    expect(report.accessibility.map((item) => item.line)).toEqual([6]);
    expect(report.verdict).toBe("目前不建議直接發布");
  });
});


describe("grammar source context", () => {
  it("returns the complete sentence containing the matched issue", () => {
    const text = "The first sentence is correct. Our tools helps your team move faster. Another sentence.";
    expect(extractSentenceAt(text, text.indexOf("helps"))).toBe(
      "Our tools helps your team move faster.",
    );
  });

  it("maps a grammar match to its exact original HTML line", () => {
    const source = [
      "<main>",
      "  <p>",
      "    The introduction is correct.",
      "    Our tools helps your team move faster.",
      "  </p>",
      "</main>",
    ].join("\n");
    const text =
      "The introduction is correct. Our tools helps your team move faster.";
    expect(locateTextLine(source, text, text.indexOf("Our"), 2)).toBe(4);
  });

  it("keeps line mapping accurate across inline HTML elements", () => {
    const source = [
      "<main>",
      "  <p>",
      "    Our <strong>tools</strong> helps your team move faster.",
      "  </p>",
      "</main>",
    ].join("\n");
    const text = "Our tools helps your team move faster.";
    expect(locateTextLine(source, text, text.indexOf("Our"), 2)).toBe(3);
  });

  it("selects the occurrence nearest the DOM fallback line", () => {
    const source = [
      "<p>Our tools helps.</p>",
      "<div>Spacer</div>",
      "<div>Spacer</div>",
      "<p>Our tools helps.</p>",
    ].join("\n");
    expect(locateTextLine(source, "Our tools helps.", 0, 4)).toBe(4);
  });
});
