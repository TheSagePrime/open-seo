import { describe, expect, it } from "vitest";
import { isClickstreamRequested } from "./clickstream";

describe("isClickstreamRequested", () => {
  it("is off unless the caller passes true", () => {
    expect(isClickstreamRequested(undefined)).toBe(false);
    expect(isClickstreamRequested(false)).toBe(false);
    expect(isClickstreamRequested(null)).toBe(false);
    expect(isClickstreamRequested(true)).toBe(true);
  });
});
