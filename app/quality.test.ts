// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { annotateSourceLines, extractTextSegments, findHighConfidenceGrammarIssues, getCategoryRatings } from "./quality";

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
      ["accessibility", "A"],
    ]);
  });
});
