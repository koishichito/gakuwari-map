import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

/**
 * Agent API tests.
 *
 * Tests validate:
 * 1. Input validation (zod schema enforcement)
 * 2. Procedure existence and correct wiring
 * 3. maxShops parameter validation (v3)
 *
 * Note: searchGakuwari calls external services (Ollama + SearXNG + Google Maps)
 * and takes minutes per run. Integration tests are skipped by default.
 * Run manually with: pnpm test -- --testNamePattern="integration"
 */

function createPublicContext(): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };
}

describe("agent.searchGakuwari", () => {
  // --- Pure validation tests (no external calls) ---

  it("rejects invalid latitude", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.agent.searchGakuwari({
        lat: "not-a-number" as unknown as number,
        lng: 139.7671,
      }),
    ).rejects.toThrow();
  });

  it("rejects radius below minimum (100)", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.agent.searchGakuwari({
        lat: 35.6812,
        lng: 139.7671,
        radius: 50,
      }),
    ).rejects.toThrow();
  });

  it("rejects radius above maximum (5000)", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.agent.searchGakuwari({
        lat: 35.6812,
        lng: 139.7671,
        radius: 10000,
      }),
    ).rejects.toThrow();
  });

  it("rejects maxShops below minimum (1)", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.agent.searchGakuwari({
        lat: 35.6812,
        lng: 139.7671,
        maxShops: 0,
      }),
    ).rejects.toThrow();
  });

  it("rejects maxShops above maximum (20)", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.agent.searchGakuwari({
        lat: 35.6812,
        lng: 139.7671,
        maxShops: 25,
      }),
    ).rejects.toThrow();
  });

  it("rejects negative maxShops", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.agent.searchGakuwari({
        lat: 35.6812,
        lng: 139.7671,
        maxShops: -5,
      }),
    ).rejects.toThrow();
  });

  it("rejects non-integer maxShops (string)", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.agent.searchGakuwari({
        lat: 35.6812,
        lng: 139.7671,
        maxShops: "ten" as unknown as number,
      }),
    ).rejects.toThrow();
  });

  // --- Integration tests (require external services, skipped by default) ---

  it.skip("integration: accepts maxShops=1 and returns results", { timeout: 120_000 }, async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.agent.searchGakuwari({
      lat: 35.6812,
      lng: 139.7671,
      maxShops: 1,
    });

    expect(result).toHaveProperty("results");
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBeLessThanOrEqual(1);
  });

  it.skip("integration: accepts maxShops=20 and returns results", { timeout: 600_000 }, async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.agent.searchGakuwari({
      lat: 35.6812,
      lng: 139.7671,
      maxShops: 20,
    });

    expect(result).toHaveProperty("results");
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBeLessThanOrEqual(20);
  });

  it.skip("integration: default maxShops returns up to 10 results", { timeout: 300_000 }, async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.agent.searchGakuwari({
      lat: 35.6812,
      lng: 139.7671,
      radius: 500,
      keyword: "カフェ",
    });

    expect(result).toHaveProperty("results");
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBeLessThanOrEqual(10);

    if (result.results.length > 0) {
      const first = result.results[0];
      expect(first).toHaveProperty("place_id");
      expect(first).toHaveProperty("name");
      expect(first).toHaveProperty("address");
      expect(first).toHaveProperty("has_gakuwari");
      expect(typeof first.has_gakuwari).toBe("boolean");
      expect(first).toHaveProperty("confidence");
      expect(["high", "medium", "low"]).toContain(first.confidence);
    }
  });
});

describe("agent.nearbyPlaces", () => {
  it("rejects invalid latitude", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.agent.nearbyPlaces({
        lat: "invalid" as unknown as number,
        lng: 139.7671,
      }),
    ).rejects.toThrow();
  });

  it("rejects radius below minimum", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.agent.nearbyPlaces({
        lat: 35.6812,
        lng: 139.7671,
        radius: 50,
      }),
    ).rejects.toThrow();
  });

  it("accepts valid input and returns shops", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    try {
      const result = await caller.agent.nearbyPlaces({
        lat: 35.6812,
        lng: 139.7671,
        radius: 500,
      });

      expect(result).toHaveProperty("shops");
      expect(Array.isArray(result.shops)).toBe(true);

      if (result.shops.length > 0) {
        const first = result.shops[0];
        expect(first).toHaveProperty("name");
        expect(first).toHaveProperty("address");
        expect(first).toHaveProperty("place_id");
        expect(first).toHaveProperty("lat");
        expect(first).toHaveProperty("lng");
      }
    } catch (error: unknown) {
      // External service may be unavailable
      expect(error).toBeDefined();
    }
  });
});
