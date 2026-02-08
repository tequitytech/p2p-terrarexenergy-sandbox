import express from "express";
import request from "supertest";
import axios from "axios";

import { buildDiscoverRequest } from "../bidding/services/market-analyzer";
import { discoverRoutes } from "./routes";

jest.mock("axios");
jest.mock("../bidding/services/market-analyzer");

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedBuildDiscoverRequest = buildDiscoverRequest as jest.MockedFunction<
  typeof buildDiscoverRequest
>;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", discoverRoutes());
  return app;
}

/** Helper: build a sample CDS response with multiple catalogs */
function makeCdsResponse(catalogs: any[]) {
  return {
    data: {
      message: { catalogs },
    },
  };
}

function makeCatalog(
  id: string,
  offers: any[],
  items: any[] = [{ "beckn:id": `item-${id}`, "beckn:isActive": true }],
) {
  return {
    "beckn:id": id,
    "beckn:offers": offers,
    "beckn:items": items,
  };
}

function makeOffer(
  id: string,
  price: number,
  maxQty: number = 10,
) {
  return {
    "beckn:id": id,
    "beckn:price": { "schema:price": price },
    "beckn:offerAttributes": {
      maximumQuantity: maxQty,
      "beckn:maxQuantity": { unitQuantity: maxQty },
    },
  };
}

describe("Discover Routes — GET /api/discover", () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
    jest.clearAllMocks();

    // Default: buildDiscoverRequest returns a minimal request body
    mockedBuildDiscoverRequest.mockReturnValue({
      context: { action: "discover" },
      message: { filters: { type: "jsonpath", expression: "$[?(@.beckn:isActive == true)]" } },
    } as any);
  });

  it("should forward discover request to CDS and return catalogs", async () => {
    const catalog = makeCatalog("cat-1", [makeOffer("off-1", 5.5)]);
    mockedAxios.post.mockResolvedValue(makeCdsResponse([catalog]));

    const res = await request(app).get("/api/discover");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.message.catalogs).toHaveLength(1);
    expect(res.body.data.message.catalogs[0]["beckn:id"]).toBe("cat-1");

    // Verify CDS was called
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://p2p.terrarexenergy.com/bap/caller/discover",
      expect.any(Object),
      expect.objectContaining({ timeout: 15000 }),
    );
  });

  it("should default sourceType to SOLAR and isActive to true", async () => {
    mockedAxios.post.mockResolvedValue(makeCdsResponse([]));

    await request(app).get("/api/discover");

    expect(mockedBuildDiscoverRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "SOLAR",
        isActive: true,
      }),
    );
  });

  it("should sort offers by price ascending within each catalog", async () => {
    const catalog = makeCatalog("cat-1", [
      makeOffer("expensive", 10),
      makeOffer("cheap", 3),
      makeOffer("mid", 6),
    ]);
    mockedAxios.post.mockResolvedValue(makeCdsResponse([catalog]));

    const res = await request(app)
      .get("/api/discover")
      .query({ sortBy: "price" });

    expect(res.status).toBe(200);
    const offers = res.body.data.message.catalogs[0]["beckn:offers"];
    expect(offers[0]["beckn:id"]).toBe("cheap");
    expect(offers[1]["beckn:id"]).toBe("mid");
    expect(offers[2]["beckn:id"]).toBe("expensive");
  });

  it("should sort offers by price descending when order=desc", async () => {
    const catalog = makeCatalog("cat-1", [
      makeOffer("cheap", 3),
      makeOffer("expensive", 10),
    ]);
    mockedAxios.post.mockResolvedValue(makeCdsResponse([catalog]));

    const res = await request(app)
      .get("/api/discover")
      .query({ sortBy: "price", order: "desc" });

    expect(res.status).toBe(200);
    const offers = res.body.data.message.catalogs[0]["beckn:offers"];
    expect(offers[0]["beckn:id"]).toBe("expensive");
    expect(offers[1]["beckn:id"]).toBe("cheap");
  });

  it("should sort offers by energy quantity", async () => {
    const catalog = makeCatalog("cat-1", [
      makeOffer("small", 5, 10),
      makeOffer("large", 5, 100),
      makeOffer("medium", 5, 50),
    ]);
    mockedAxios.post.mockResolvedValue(makeCdsResponse([catalog]));

    const res = await request(app)
      .get("/api/discover")
      .query({ sortBy: "energy" });

    expect(res.status).toBe(200);
    const offers = res.body.data.message.catalogs[0]["beckn:offers"];
    expect(offers[0]["beckn:id"]).toBe("small");
    expect(offers[1]["beckn:id"]).toBe("medium");
    expect(offers[2]["beckn:id"]).toBe("large");
  });

  it("should sort catalogs by their best offer", async () => {
    // cat-expensive has cheapest offer at 8, cat-cheap has cheapest at 2
    const catExpensive = makeCatalog("cat-expensive", [makeOffer("off-a", 8)]);
    const catCheap = makeCatalog("cat-cheap", [makeOffer("off-b", 2)]);
    mockedAxios.post.mockResolvedValue(makeCdsResponse([catExpensive, catCheap]));

    const res = await request(app)
      .get("/api/discover")
      .query({ sortBy: "price" });

    expect(res.status).toBe(200);
    const catalogs = res.body.data.message.catalogs;
    expect(catalogs[0]["beckn:id"]).toBe("cat-cheap");
    expect(catalogs[1]["beckn:id"]).toBe("cat-expensive");
  });

  it("should filter items by tag=farmer (schema:name match)", async () => {
    const catalog = makeCatalog("cat-1", [makeOffer("off-1", 5)], [
      {
        "beckn:id": "item-farmer",
        "beckn:provider": {
          "beckn:descriptor": { "schema:name": "Suresh - BRPL Prosumer" },
        },
      },
      {
        "beckn:id": "item-other",
        "beckn:provider": {
          "beckn:descriptor": { "schema:name": "Regular Seller" },
        },
      },
    ]);
    mockedAxios.post.mockResolvedValue(makeCdsResponse([catalog]));

    const res = await request(app)
      .get("/api/discover")
      .query({ tag: "farmer" });

    expect(res.status).toBe(200);
    const items = res.body.data.message.catalogs[0]["beckn:items"];
    expect(items).toHaveLength(1);
    expect(items[0]["beckn:id"]).toBe("item-farmer");
  });

  it("should return 500 when CDS request fails", async () => {
    mockedAxios.post.mockRejectedValue(new Error("ECONNREFUSED"));

    const consoleSpy = jest.spyOn(console, "log").mockImplementation();

    const res = await request(app).get("/api/discover");

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("ECONNREFUSED");

    consoleSpy.mockRestore();
  });

  it("should handle empty catalogs from CDS gracefully", async () => {
    mockedAxios.post.mockResolvedValue({ data: { message: { catalogs: [] } } });

    const res = await request(app).get("/api/discover");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.message.catalogs).toEqual([]);
  });
});
