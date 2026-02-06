import { readFileSync } from "fs";
import { isAxiosError } from "axios";
import {
  normalizeDomain,
  readDomainResponse,
  parseError,
  calculatePrice,
  calculateTotalAmount,
} from "./index";

jest.mock("fs", () => ({
  readFileSync: jest.fn(),
}));

jest.mock("axios", () => ({
  isAxiosError: jest.fn(),
}));

const mockedReadFileSync = readFileSync as unknown as jest.Mock;
const mockedIsAxiosError = isAxiosError as unknown as jest.Mock;

describe("utils/index.ts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("normalizeDomain", () => {
    it("should strip version suffix after final colon but keep port", () => {
      expect(normalizeDomain("p2p.terrarexenergy.com:443:1.0.0")).toBe(
        "p2p.terrarexenergy.com:443",
      );
    });

    it("should return input when domain is falsy", () => {
      expect(normalizeDomain("")).toBe("");
      expect(normalizeDomain(undefined as any)).toBeUndefined();
    });
  });

  describe("readDomainResponse", () => {
    it("should read persona-specific response when file exists", async () => {
      const data = { ok: true };
      mockedReadFileSync.mockReturnValueOnce(JSON.stringify(data));

      const result = await readDomainResponse(
        "p2p.terrarexenergy.com",
        "on_search",
        "prosumer",
      );

      expect(result).toEqual(data);
      expect(mockedReadFileSync).toHaveBeenCalledTimes(1);
    });

    it("should fall back to default path when persona file missing", async () => {
      const data = { ok: true };
      // First call: persona path → ENOENT
      const enoentError: any = new Error("not found");
      enoentError.code = "ENOENT";
      mockedReadFileSync
        .mockImplementationOnce(() => {
          throw enoentError;
        })
        .mockImplementationOnce(() => JSON.stringify(data));

      const result = await readDomainResponse(
        "p2p.terrarexenergy.com",
        "on_search",
        "prosumer",
      );

      expect(result).toEqual(data);
      expect(mockedReadFileSync).toHaveBeenCalledTimes(2);
    });

    it("should return empty object when default file missing", async () => {
      const enoentError: any = new Error("not found");
      enoentError.code = "ENOENT";
      mockedReadFileSync.mockImplementation(() => {
        throw enoentError;
      });

      const result = await readDomainResponse(
        "p2p.terrarexenergy.com",
        "on_search",
      );

      expect(result).toEqual({});
    });
  });

  describe("parseError", () => {
    it("should return axios error message from response data", () => {
      const axiosError: any = new Error("bad");
      axiosError.response = {
        data: {
          message: { error: { message: "Upstream failed" } },
        },
      };
      mockedIsAxiosError.mockReturnValue(true);

      const msg = parseError(axiosError);
      expect(msg).toBe("Upstream failed");
    });

    it("should return generic error message for non-axios errors", () => {
      mockedIsAxiosError.mockReturnValue(false);
      const err = new Error("plain");

      const msg = parseError(err);
      expect(msg).toBe("plain");
    });

    it("should return null for non-Error inputs", () => {
      const msg = parseError({} as any);
      expect(msg).toBeNull();
    });
  });

  describe("calculatePrice / calculateTotalAmount", () => {
    it("should calculate PER_KWH price with wheeling charges", () => {
      const amount = calculatePrice({
        pricingModel: "PER_KWH",
        basePrice: 6,
        quantity: 10,
        wheelingCharges: 1.5,
      });

      expect(amount).toBe(6 * 10 + 1.5);
    });

    it("should fall back to basePrice for unknown pricing model", () => {
      const amount = calculatePrice({
        // @ts-expect-error testing default branch
        pricingModel: "UNKNOWN",
        basePrice: 5,
        quantity: 3,
      });

      expect(amount).toBe(15);
    });

    it("should calculate total amount from offer structure", () => {
      const offer = {
        "beckn:price": { "schema:price": 7 },
        "beckn:offerAttributes": {
          pricingModel: "PER_KWH",
          wheelingCharges: { amount: 0.5 },
        },
      };

      const amount = calculateTotalAmount(offer, 4);
      expect(amount).toBe(7 * 4 + 0.5);
    });
  });
});

