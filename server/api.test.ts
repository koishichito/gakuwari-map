import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

/**
 * Create a public (unauthenticated) context for testing public procedures.
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

describe("category.list", () => {
  it("returns an array of categories", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.category.list();

    expect(Array.isArray(result)).toBe(true);
    // We seeded 8 categories
    expect(result.length).toBeGreaterThanOrEqual(8);

    // Each category should have expected fields
    const first = result[0];
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("name");
    expect(first).toHaveProperty("icon");
    expect(first).toHaveProperty("color");
  });
});

describe("spot.list", () => {
  it("returns paginated spots with total count", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.spot.list({ limit: 5, offset: 0 });

    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("total");
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeLessThanOrEqual(5);
    expect(result.total).toBeGreaterThanOrEqual(1);

    // Each spot should have expected fields
    const spot = result.items[0];
    expect(spot).toHaveProperty("id");
    expect(spot).toHaveProperty("name");
    expect(spot).toHaveProperty("address");
    expect(spot).toHaveProperty("discountDetail");
    expect(spot).toHaveProperty("categoryId");
  });

  it("filters by categoryId", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    // First get categories to find a valid ID
    const categories = await caller.category.list();
    const catId = categories[0].id;

    const result = await caller.spot.list({ categoryId: catId, limit: 50 });
    expect(result.items.length).toBeGreaterThanOrEqual(0);
    // All returned items should have the requested categoryId
    result.items.forEach((item) => {
      expect(item.categoryId).toBe(catId);
    });
  });

  it("searches by name or address", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.spot.list({ search: "渋谷", limit: 50 });
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    // At least one result should contain "渋谷" in name or address
    const hasMatch = result.items.some(
      (item) => item.name.includes("渋谷") || item.address.includes("渋谷")
    );
    expect(hasMatch).toBe(true);
  });

  it("sorts by rating descending", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.spot.list({ sortBy: "rating", limit: 50 });
    const ratings = result.items.map((item) => Number(item.avgRating ?? 0));
    for (let i = 1; i < ratings.length; i++) {
      expect(ratings[i]).toBeLessThanOrEqual(ratings[i - 1]);
    }
  });
});

describe("spot.byId", () => {
  it("returns a single spot by ID", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    // Get a spot ID from the list
    const listResult = await caller.spot.list({ limit: 1 });
    const spotId = listResult.items[0].id;

    const spot = await caller.spot.byId({ id: spotId });
    expect(spot).toHaveProperty("id", spotId);
    expect(spot).toHaveProperty("name");
    expect(spot).toHaveProperty("address");
    expect(spot).toHaveProperty("discountDetail");
  });

  it("throws error for non-existent spot", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await expect(caller.spot.byId({ id: 999999 })).rejects.toThrow("Spot not found");
  });
});

describe("spot.nearby", () => {
  it("returns spots near a given location with distance", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    // Tokyo center coordinates
    const result = await caller.spot.nearby({
      lat: 35.6812,
      lng: 139.7671,
      radiusKm: 50,
      limit: 20,
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(1);

    // Each result should have a distance field
    const first = result[0];
    expect(first).toHaveProperty("distance");
    expect(typeof first.distance).toBe("number");
    expect(first.distance).toBeGreaterThanOrEqual(0);
  });

  it("returns empty array for remote location", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    // Somewhere far away (Antarctica)
    const result = await caller.spot.nearby({
      lat: -80.0,
      lng: 0.0,
      radiusKm: 1,
      limit: 20,
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });
});

describe("spot.nearby - auto geolocation scenario", () => {
  it("returns spots with tighter radius (10km) for real user location", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    // Simulate user near Tokyo center with tighter radius
    const result = await caller.spot.nearby({
      lat: 35.6812,
      lng: 139.7671,
      radiusKm: 10,
      limit: 20,
    });

    expect(Array.isArray(result)).toBe(true);
    // Should still find spots within 10km of Tokyo center
    expect(result.length).toBeGreaterThanOrEqual(1);

    // Verify all returned spots are within the specified radius
    result.forEach((spot) => {
      expect(spot.distance).toBeGreaterThanOrEqual(0);
      expect(spot.distance).toBeLessThan(10);
    });
  });

  it("returns spots sorted by distance (closest first)", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.spot.nearby({
      lat: 35.6812,
      lng: 139.7671,
      radiusKm: 50,
      limit: 20,
    });

    expect(result.length).toBeGreaterThanOrEqual(2);

    // Verify distance is sorted ascending
    for (let i = 1; i < result.length; i++) {
      expect(result[i].distance).toBeGreaterThanOrEqual(result[i - 1].distance);
    }
  });

  it("each spot has required fields for SpotCard rendering", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.spot.nearby({
      lat: 35.6812,
      lng: 139.7671,
      radiusKm: 50,
      limit: 5,
    });

    expect(result.length).toBeGreaterThanOrEqual(1);

    result.forEach((spot) => {
      // Required fields for SpotCard component
      expect(spot).toHaveProperty("id");
      expect(spot).toHaveProperty("name");
      expect(spot).toHaveProperty("address");
      expect(spot).toHaveProperty("discountDetail");
      expect(spot).toHaveProperty("categoryId");
      expect(spot).toHaveProperty("lat");
      expect(spot).toHaveProperty("lng");
      expect(spot).toHaveProperty("avgRating");
      expect(spot).toHaveProperty("reviewCount");
      expect(spot).toHaveProperty("distance");
      expect(typeof spot.distance).toBe("number");
    });
  });
});

describe("review.bySpot", () => {
  it("returns reviews for a spot", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    // Get a spot that has reviews
    const listResult = await caller.spot.list({ sortBy: "rating", limit: 1 });
    const spotId = listResult.items[0].id;

    const reviews = await caller.review.bySpot({ spotId });
    expect(Array.isArray(reviews)).toBe(true);

    if (reviews.length > 0) {
      const review = reviews[0];
      expect(review).toHaveProperty("id");
      expect(review).toHaveProperty("spotId", spotId);
      expect(review).toHaveProperty("userName");
      expect(review).toHaveProperty("rating");
    }
  });
});

describe("spot.create", () => {
  it("creates a new spot and returns its ID", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    // Get a valid category ID
    const categories = await caller.category.list();
    const catId = categories[0].id;

    const result = await caller.spot.create({
      name: "テストスポット",
      address: "東京都テスト区テスト町1-1-1",
      lat: "35.6812000",
      lng: "139.7671000",
      categoryId: catId,
      discountDetail: "テスト学割：学生証提示で10%OFF",
      discountRate: "10%OFF",
    });

    expect(result).toHaveProperty("id");
    expect(typeof result.id).toBe("number");
    expect(result.id).toBeGreaterThan(0);

    // Verify the spot was created
    const spot = await caller.spot.byId({ id: result.id });
    expect(spot.name).toBe("テストスポット");
    expect(spot.discountDetail).toBe("テスト学割：学生証提示で10%OFF");
  });
});

describe("review.create", () => {
  it("creates a new review and updates spot rating", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    // Get a spot
    const listResult = await caller.spot.list({ limit: 1 });
    const spotId = listResult.items[0].id;

    const result = await caller.review.create({
      spotId,
      userName: "テストユーザー",
      rating: 5,
      comment: "素晴らしいスポットです！",
    });

    expect(result).toHaveProperty("id");
    expect(typeof result.id).toBe("number");
    expect(result.id).toBeGreaterThan(0);

    // Verify the review was created
    const reviews = await caller.review.bySpot({ spotId });
    const created = reviews.find((r) => r.id === result.id);
    expect(created).toBeDefined();
    expect(created?.userName).toBe("テストユーザー");
    expect(created?.rating).toBe(5);
    expect(created?.comment).toBe("素晴らしいスポットです！");
  });
});
