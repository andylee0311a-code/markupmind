// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { annotateSourceLines, buildQualityReport, extractSentenceAt, extractTextSegments, findHighConfidenceGrammarIssues, getCategoryRatings, getSegmentLintMode, isActionableSpelling, isSafeGrammarSuggestion, locateTextLine, maskProtectedProductText } from "./quality";

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

  it("keeps sibling specification contexts separate", () => {
    const source = [
      "<li>",
      "  <div>QWERTY, full row of F1 to F12 function keys</div>",
      "  <div>Keys for Windows shortcuts, media controls, screen brightness</div>",
      "</li>",
    ].join("\n");
    expect(extractTextSegments(source)).toEqual([
      { text: "QWERTY, full row of F1 to F12 function keys", line: 2 },
      {
        text: "Keys for Windows shortcuts, media controls, screen brightness",
        line: 3,
      },
    ]);
  });

  it("does not report repeated words across semantic container boundaries", () => {
    const source =
      "<td><div>full row of function keys</div><div>Keys for Windows shortcuts</div></td>";
    const findings = extractTextSegments(source).flatMap((segment) =>
      findHighConfidenceGrammarIssues(segment.text),
    );
    expect(findings.filter((finding) => finding.title === "英文單字重複")).toHaveLength(0);
  });

  it("still detects a repeated word inside the same sentence", () => {
    const segments = extractTextSegments("<p>The keyboard has has a backlight.</p>");
    expect(
      findHighConfidenceGrammarIssues(segments[0].text).some(
        (finding) => finding.title === "英文單字重複",
      ),
    ).toBe(true);
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


describe("technical grammar calibration", () => {
  const specification =
    '6” touchscreen, an Intel® Core™ i7/i5 processor, and a full-sized keyboard set.';

  it("treats a product specification list as spelling-only", () => {
    expect(getSegmentLintMode(specification)).toBe("spelling");
  });

  it("masks brands, trademarks and processor models while preserving offsets", () => {
    const masked = maskProtectedProductText(specification);
    expect(masked).toHaveLength(specification.length);
    expect(masked).not.toMatch(/Intel|Core|i7|i5|®|™/);
    expect(masked).toContain("touchscreen");
  });

  it("rejects a punctuation-prefixed replacement for a grammar finding", () => {
    expect(
      isSafeGrammarSuggestion("Intel", ".Intel", "Agreement", "full"),
    ).toBe(false);
  });

  it("does not allow full grammar advice in spelling-only fragments", () => {
    expect(
      isSafeGrammarSuggestion("Intel", "intel", "Agreement", "spelling"),
    ).toBe(false);
  });

  it("keeps the known environmental spelling correction", () => {
    expect(
      isSafeGrammarSuggestion(
        "Enviromental",
        "Environmental",
        "Spelling",
        "spelling",
      ),
    ).toBe(true);
  });
});


describe("product proper-noun protection", () => {
  const connector = "24-pin Fischer MiniMax Connector (optional)";

  it("masks CamelCase product-series names before spelling analysis", () => {
    const masked = maskProtectedProductText(connector);
    expect(masked).toHaveLength(connector.length);
    expect(masked).not.toContain("MiniMax");
    expect(masked).toContain("Connector");
  });

  it("recognizes Fischer and MiniMax as approved product terminology", () => {
    expect(isActionableSpelling("Fischer", "Fisher")).toBe(false);
    expect(isActionableSpelling("MiniMax", "Minima")).toBe(false);
  });

  it("does not create a spelling finding for the protected connector name", () => {
    const masked = maskProtectedProductText(connector);
    expect(masked.slice(connector.indexOf("MiniMax"), connector.indexOf("MiniMax") + "MiniMax".length).trim()).toBe("");
  });
});


describe("mixed-case technical-term protection", () => {
  it("masks microSD without changing source offsets", () => {
    const source = "microSD Slot";
    const masked = maskProtectedProductText(source);
    expect(masked).toHaveLength(source.length);
    expect(masked.slice(0, "microSD".length).trim()).toBe("");
    expect(masked).toContain("Slot");
  });

  it("rejects dictionary replacements for the microSD specification name", () => {
    expect(isActionableSpelling("microSD", "microS")).toBe(false);
    expect(isActionableSpelling("microSD", "micros")).toBe(false);
  });

  it("keeps mixed-case technical labels in spelling-only mode", () => {
    expect(getSegmentLintMode("microSD Slot")).toBe("spelling");
  });
});
