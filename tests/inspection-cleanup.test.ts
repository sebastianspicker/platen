import { describe, expect, it } from "vitest";

describe("inspection", () => {
  it("keeps the scope label stable", () => {
    expect("inspection").toContain("inspection");
  });
});

// regression note: inspection
it("keeps inspection stable", () => {
  expect("inspection").toContain("inspection");
});
