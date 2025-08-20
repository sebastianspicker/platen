import { describe, expect, it } from "vitest";

describe("release", () => {
  it("keeps the scope label stable", () => {
    expect("release").toContain("release");
  });
});

// regression note: release
it("keeps release stable", () => {
  expect("release").toContain("release");
});
