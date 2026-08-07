import { describe, it, expect } from "vitest";
import { renderRoleHint, shortenDescription } from "./persona-resolver.js";

describe("renderRoleHint", () => {
  it("uses persona.role when present", () => {
    expect(
      renderRoleHint({
        persona: "cmo",
        frontmatter: { name: "cmo", role: "CMO", description: "..." },
      }),
    ).toBe("CMO");
  });

  it("derives title-case from the slug when role is absent", () => {
    expect(
      renderRoleHint({
        persona: "cmo",
        frontmatter: { name: "cmo", role: null, description: "..." },
      }),
    ).toBe("Cmo");
    expect(
      renderRoleHint({
        persona: "sales-engineer",
        frontmatter: { name: "sales-engineer", role: null, description: "..." },
      }),
    ).toBe("Sales Engineer");
  });

  it("falls back to the slug verbatim when the persona file is not found", () => {
    expect(renderRoleHint({ persona: "cmo", frontmatter: null })).toBe(
      "cmo (persona file not found)",
    );
  });

  it("returns null when the persona key is itself empty/null", () => {
    expect(renderRoleHint({ persona: null, frontmatter: null })).toBeNull();
  });
});

describe("shortenDescription", () => {
  it("returns the first sentence", () => {
    expect(
      shortenDescription(
        "Chief Marketing Officer virtual worker — owns brand, growth, demand-gen. Operates with stage-aware opinions.",
      ),
    ).toBe("Chief Marketing Officer virtual worker — owns brand, growth, demand-gen");
  });

  it("returns the full string when there's only one sentence and no period", () => {
    expect(shortenDescription("Short tagline no period")).toBe("Short tagline no period");
  });

  it("caps overly-long single sentences at 80 chars with ellipsis", () => {
    const long = "A".repeat(200);
    expect(shortenDescription(long).length).toBeLessThanOrEqual(83);
  });
});
