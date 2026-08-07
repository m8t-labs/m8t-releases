import { describe, it, expect } from "vitest";
import { parseBrainLink } from "./brain-link.js";

describe("parseBrainLink", () => {
  it("parses a valid JSON brain link from metadata", () => {
    const metadata = {
      source: "m8t",
      brain: JSON.stringify({
        repo: "orkeren21/cmo-brain-f01",
        branch: "main",
        topology: "per-worker",
        schemaVersion: "1",
        credentialRef: "brain-cmo-brain",
      }),
    };
    expect(parseBrainLink(metadata)).toEqual({
      repo: "orkeren21/cmo-brain-f01",
      branch: "main",
      topology: "per-worker",
      schemaVersion: "1",
      credentialRef: "brain-cmo-brain",
    });
  });

  it("returns undefined when there is no brain key", () => {
    expect(parseBrainLink({ source: "m8t" })).toBeUndefined();
    expect(parseBrainLink(undefined)).toBeUndefined();
  });

  it("returns undefined (never throws) on malformed JSON", () => {
    expect(parseBrainLink({ brain: "{not json" })).toBeUndefined();
  });

  it("returns undefined when repo is missing", () => {
    expect(parseBrainLink({ brain: JSON.stringify({ branch: "main" }) })).toBeUndefined();
  });

  it("defaults branch to main and topology to per-worker", () => {
    const link = parseBrainLink({ brain: JSON.stringify({ repo: "o/r", topology: "bogus" }) });
    expect(link?.branch).toBe("main");
    expect(link?.topology).toBe("per-worker");
    expect(link?.schemaVersion).toBe("1");
  });
});
