import { Request, Response } from "express";
import { mockRequest, mockResponse } from "../test-utils";

// Mock the bid-optimizer service
jest.mock("./services/bid-optimizer", () => ({
  preview: jest.fn(),
  confirm: jest.fn(),
}));

import { preview, confirm } from "./services/bid-optimizer";
import { previewBid, confirmBid } from "./controller";

const mockedPreview = preview as jest.MockedFunction<typeof preview>;
const mockedConfirm = confirm as jest.MockedFunction<typeof confirm>;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function validBody(overrides: Record<string, any> = {}) {
  return {
    provider_id: "prov-001",
    meter_id: "meter-001",
    source_type: "SOLAR",
    ...overrides,
  };
}

// ─── previewBid ─────────────────────────────────────────────────────────────

describe("previewBid", () => {
  it("should return 400 when provider_id is missing", async () => {
    const req = mockRequest({ meter_id: "m", source_type: "SOLAR" });
    const { res, status, json } = mockResponse();

    await previewBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining("provider_id"),
      })
    );
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it("should return 400 when meter_id is missing", async () => {
    const req = mockRequest({ provider_id: "p", source_type: "SOLAR" });
    const { res, status, json } = mockResponse();

    await previewBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining("meter_id"),
      })
    );
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it("should return 400 when source_type is invalid (not SOLAR/WIND/BATTERY)", async () => {
    const req = mockRequest(validBody({ source_type: "HYDRO" }));
    const { res, status, json } = mockResponse();

    await previewBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining("source_type"),
      })
    );
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it("should return 200 with preview result for valid request", async () => {
    const previewResult = {
      success: true,
      seller: { provider_id: "prov-001", meter_id: "meter-001" },
      summary: { total_days: 7, biddable_days: 5 },
      bids: [{ date: "2026-02-10", quantity: 15, price: 4.5 }],
    };
    mockedPreview.mockResolvedValue(previewResult as any);

    const req = mockRequest(validBody());
    const { res, status, json } = mockResponse();

    await previewBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(previewResult);
    expect(mockedPreview).toHaveBeenCalledWith({
      provider_id: "prov-001",
      meter_id: "meter-001",
      source_type: "SOLAR",
    });
  });

  it("should return 400 when preview() throws error containing 'not found'", async () => {
    mockedPreview.mockRejectedValue(new Error("Forecast data not found for meter"));

    const req = mockRequest(validBody());
    const { res, status, json } = mockResponse();

    await previewBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "Forecast data not found for meter",
      })
    );
  });

  it("should return 500 for unexpected errors", async () => {
    mockedPreview.mockRejectedValue(new Error("Connection timeout"));

    const req = mockRequest(validBody());
    const { res, status, json } = mockResponse();

    await previewBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "Connection timeout",
      })
    );
  });
});

// ─── confirmBid ─────────────────────────────────────────────────────────────

describe("confirmBid", () => {
  it("should return 400 when provider_id is missing", async () => {
    const req = mockRequest({ meter_id: "m", source_type: "WIND" });
    const { res, status, json } = mockResponse();

    await confirmBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining("provider_id"),
      })
    );
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it("should return 200 with placed_bids for valid request", async () => {
    const confirmResult = {
      success: true,
      placed_bids: [
        { catalog_id: "cat-1", offer_id: "off-1", item_id: "item-1", status: "published" },
      ],
    };
    mockedConfirm.mockResolvedValue(confirmResult as any);

    const req = mockRequest(validBody({ source_type: "WIND" }));
    const { res, status, json } = mockResponse();

    await confirmBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(confirmResult);
    expect(mockedConfirm).toHaveBeenCalledWith(
      { provider_id: "prov-001", meter_id: "meter-001", source_type: "WIND" },
      undefined
    );
  });

  it("should pass max_bids param to confirm() when provided", async () => {
    mockedConfirm.mockResolvedValue({ success: true, placed_bids: [] } as any);

    const req = mockRequest(validBody({ max_bids: "3" }));
    const { res, status, json } = mockResponse();

    await confirmBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(200);
    expect(mockedConfirm).toHaveBeenCalledWith(
      { provider_id: "prov-001", meter_id: "meter-001", source_type: "SOLAR" },
      3
    );
  });

  it("should return 400 when confirm() throws 'malformed' error", async () => {
    mockedConfirm.mockRejectedValue(new Error("Request body malformed"));

    const req = mockRequest(validBody());
    const { res, status, json } = mockResponse();

    await confirmBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "Request body malformed",
      })
    );
  });

  it("should return 500 for unexpected errors", async () => {
    mockedConfirm.mockRejectedValue(new Error("Publish endpoint unavailable"));

    const req = mockRequest(validBody());
    const { res, status, json } = mockResponse();

    await confirmBid(req as Request, res as Response);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "Publish endpoint unavailable",
      })
    );
  });
});
