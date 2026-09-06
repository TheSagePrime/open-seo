import { beforeEach, describe, expect, it, vi } from "vitest";

const r2 = vi.hoisted(() => {
  const store = new Map<
    string,
    { body: string; customMetadata?: Record<string, string> }
  >();
  return {
    store,
    get: async (key: string) => {
      const obj = store.get(key);
      if (!obj) return null;
      return {
        customMetadata: obj.customMetadata,
        text: async () => obj.body,
      };
    },
    put: async (
      key: string,
      body: string,
      options?: { customMetadata?: Record<string, string> },
    ) => {
      store.set(key, {
        body,
        customMetadata: options?.customMetadata,
      });
    },
  };
});

vi.mock("cloudflare:workers", () => ({
  env: { R2: r2 },
}));

import { getCached, setCached } from "./r2-cache";

describe("r2-cache persistence", () => {
  beforeEach(() => {
    r2.store.clear();
  });

  it("reads back a value after a simulated service restart", async () => {
    await setCached("kw:metrics:demo", { keyword: "linux vps" }, 3600);
    const snapshot = new Map(r2.store);

    r2.store.clear();
    for (const [key, value] of snapshot) {
      r2.store.set(key, value);
    }

    await expect(getCached("kw:metrics:demo")).resolves.toEqual({
      keyword: "linux vps",
    });
  });
});
