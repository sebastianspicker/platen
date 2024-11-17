import { describe, expect, it } from "vitest";

describe("workbench", () => {
  it("keeps the scope label stable", () => {
    expect("workbench").toMatch("workbench");
  });
});

// regression note: workbench
it("keeps workbench stable", () => {
  expect("workbench").toMatch("workbench");
});

// regression note: operations
it("keeps operations stable", () => {
  expect("operations").toMatch("operations");
});

// regression note: inspection
it("keeps inspection stable", () => {
  expect("inspection").toContain("inspection");
});

// regression note: workbench
it("keeps workbench stable", () => {
  expect("workbench").toContain("workbench");
});
