import { Request, Response } from "express";
import { mockRequest, mockResponse } from "../test-utils";

// Mock the DB module
jest.mock("../db", () => {
  const mockFindOne = jest.fn();
  return {
    getDB: jest.fn(() => ({
      collection: jest.fn(() => ({
        findOne: mockFindOne,
      })),
    })),
    __mockFindOne: mockFindOne,
  };
});

// Mock trading rules
jest.mock("../trade/trading-rules", () => ({
  tradingRules: {
    getRules: jest.fn().mockResolvedValue({
      sellerSafetyFactor: 1.0,
      buyerSafetyFactor: 1.0,
      enableBuyerLimits: true,
      enableSellerLimits: true,
    }),
  },
}));

// Mock the hourly-optimizer service
jest.mock("./services/hourly-optimizer", () => ({
  preview: jest.fn(),
  confirm: jest.fn(),
}));

import { preview, confirm } from "./services/hourly-optimizer";
import { previewSellerBid, confirmSellerBid } from "./controller";

const mockedPreview = preview as jest.MockedFunction<typeof preview>;
const mockedConfirm = confirm as jest.MockedFunction<typeof confirm>;

// Access the mock findOne via the module
const { __mockFindOne: mockFindOne } = jest.requireMock("../db") as {
  __mockFindOne: jest.Mock;
};

const SELLER_USER = {
  _id: { toString: () => "abc123userId" },
  phone: "9876543210",
  profiles: {
    generationProfile: {
      did: "did:example:seller-123",
      meterNumber: "300400500",
      capacityKW: "10",
    },
    consumptionProfile: {
      sanctionedLoadKW: "10",
    },
  },
  meters: ["300400500"],
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
  // Default: user found with generation profile
  mockFindOne.mockResolvedValue(SELLER_USER);
});

afterEach(() => {
  jest.restoreAllMocks();
});

function makeReq(
  bodyOverrides: Record<string, any> = {},
  userOverrides: Record<string, any> = {}
): Partial<Request> {
  const req = mockRequest({ source_type: "SOLAR", ...bodyOverrides });
  (req as any).user = { phone: "9876543210", ...userOverrides };
  (req as any).headers = {
    authorization: "Bearer test-token-abc",
  };
  return req;
}

// ─── previewSellerBid ────────────────────────────────────────────────────────

describe("previewSellerBid", () => {
  it("should return 400 when source_type is missing", async () => {
    const req = makeReq({ source_type: undefined });
    const { res, status, json } = mockResponse();

    await previewSellerBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining("source_type"),
      })
    );
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it("should return 400 when source_type is not SOLAR/WIND/BATTERY", async () => {
    const req = makeReq({ source_type: "HYDRO" });
    const { res, status, json } = mockResponse();

    await previewSellerBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining("source_type"),
      })
    );
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it("should return 500 when user profile not found", async () => {
    mockFindOne.mockResolvedValue(null);

    const req = makeReq();
    const { res, status, json } = mockResponse();

    await previewSellerBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "User profile not found",
      })
    );
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it("should return 500 when user has no generationProfile", async () => {
    mockFindOne.mockResolvedValue({ phone: "9876543210", profiles: {} });

    const req = makeReq();
    const { res, status, json } = mockResponse();

    await previewSellerBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining("generationProfile"),
      })
    );
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it("should return 200 with preview result using profile-derived provider_id and meter_id", async () => {
    const previewResult = {
      success: true,
      seller: {
        provider_id: "did:example:seller-123",
        meter_id: "300400500",
      },
      target_date: "2026-02-09",
      recommended_bids: [
        { hour: "10:00", quantity: 5.0, price: 4.5 },
        { hour: "11:00", quantity: 8.0, price: 4.2 },
      ],
    };
    mockedPreview.mockResolvedValue(previewResult as any);

    const req = makeReq();
    const { res, status, json } = mockResponse();

    await previewSellerBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(previewResult);
    expect(mockedPreview).toHaveBeenCalledWith(
      {
        provider_id: "did:example:seller-123",
        meter_id: "300400500",
        source_type: "SOLAR",
      },
      10,
      "abc123userId"
    );
  });

  it("should return 500 when preview() throws an error", async () => {
    mockedPreview.mockRejectedValue(new Error("Forecast service unavailable"));

    const req = makeReq();
    const { res, status, json } = mockResponse();

    await previewSellerBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "Forecast service unavailable",
      })
    );
  });

  it("should use meters[0] as fallback when meterNumber is missing", async () => {
    mockFindOne.mockResolvedValue({
      _id: { toString: () => "fallbackUserId" },
      phone: "9876543210",
      profiles: {
        generationProfile: {
          did: "did:example:seller-123",
          capacityKW: "10",
          // no meterNumber
        },
        consumptionProfile: {
          sanctionedLoadKW: "10",
        },
      },
      meters: ["fallback-meter-001"],
    });
    mockedPreview.mockResolvedValue({ success: true } as any);

    const req = makeReq();
    const { res, status } = mockResponse();

    await previewSellerBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(200);
    expect(mockedPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        meter_id: "fallback-meter-001",
      }),
      expect.any(Number),
      expect.any(String)
    );
  });
});

// ─── confirmSellerBid ────────────────────────────────────────────────────────

describe("confirmSellerBid", () => {
  it("should return 400 when source_type is invalid", async () => {
    const req = makeReq({ source_type: "GEOTHERMAL" });
    const { res, status, json } = mockResponse();

    await confirmSellerBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining("source_type"),
      })
    );
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it("should return 500 when user has no generationProfile", async () => {
    mockFindOne.mockResolvedValue({
      phone: "9876543210",
      profiles: { consumptionProfile: {} },
    });

    const req = makeReq();
    const { res, status, json } = mockResponse();

    await confirmSellerBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining("generationProfile"),
      })
    );
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it("should pass authorization token to confirm()", async () => {
    mockedConfirm.mockResolvedValue({ success: true, placed_bids: [] } as any);

    const req = makeReq();
    const { res, status } = mockResponse();

    await confirmSellerBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(200);
    expect(mockedConfirm).toHaveBeenCalledWith(
      {
        provider_id: "did:example:seller-123",
        meter_id: "300400500",
        source_type: "SOLAR",
      },
      "Bearer test-token-abc",
      10,
      "abc123userId"
    );
  });

  it("should return 200 with placed_bids for valid request", async () => {
    const confirmResult = {
      success: true,
      placed_bids: [
        {
          hour: "10:00",
          catalog_id: "cat-1",
          offer_id: "off-1",
          item_id: "item-1",
          status: "published",
        },
        {
          hour: "11:00",
          catalog_id: "cat-2",
          offer_id: "off-2",
          item_id: "item-2",
          status: "published",
        },
      ],
    };
    mockedConfirm.mockResolvedValue(confirmResult as any);

    const req = makeReq({ source_type: "WIND" });
    const { res, status, json } = mockResponse();

    await confirmSellerBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(confirmResult);
    expect(mockedConfirm).toHaveBeenCalledWith(
      {
        provider_id: "did:example:seller-123",
        meter_id: "300400500",
        source_type: "WIND",
      },
      "Bearer test-token-abc",
      10,
      "abc123userId"
    );
  });

  it("should return 500 for unexpected errors", async () => {
    mockedConfirm.mockRejectedValue(new Error("Publish endpoint unreachable"));

    const req = makeReq();
    const { res, status, json } = mockResponse();

    await confirmSellerBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "Publish endpoint unreachable",
      })
    );
  });
});
