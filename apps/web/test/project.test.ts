import { describe, expect, it } from "vitest";
import { isProjectId } from "../src/lib/project.js";

describe("isProjectId", () => {
  it("accepts a UUID used by the server project routes", () => {
    expect(isProjectId("0192af7d-b792-7a41-90f8-9f0b2d6c6d8a")).toBe(true);
  });

  it("rejects empty values and arbitrary route text", () => {
    expect(isProjectId("")).toBe(false);
    expect(isProjectId("my-project")).toBe(false);
  });
});
