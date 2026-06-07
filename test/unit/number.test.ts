import { describe, expect, it } from "vitest";
import { clampNumber } from "../../src/lib/number";

describe("number", () => {
  it("clamps values to min and max", () => {
    expect(clampNumber(5, 1, 10)).toBe(5);
    expect(clampNumber(-1, 1, 10)).toBe(1);
    expect(clampNumber(99, 1, 10)).toBe(10);
  });
});
