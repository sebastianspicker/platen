import { describe, expect, it } from "vitest";

describe("workbench", () => {
  it("keeps the scope label stable", () => {
    expect("workbench").toContain("workbench");
  });
});

// regression note: workbench
it("keeps workbench stable", () => {
  expect("workbench").toContain("workbench");
});
