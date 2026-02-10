import crypto from "crypto";
import { readFileSync } from "fs";
import path from "path";

import { isAxiosError } from "axios";

const RESPONSES_BASE_PATH = path.resolve(__dirname, "../webhook/jsons");

export const normalizeDomain = (domain: string) => {
  if (!domain) {
    return domain;
  }
  return domain.replace(/:\d+(?:\.\d+)*$/, "");
};

export const readDomainResponse = async (
  domain: string,
  action: string,
  persona?: string
) => {
  const normalizedDomain = normalizeDomain(domain);

  // If persona is specified, try persona-specific path first
  if (persona) {
    const personaPath = path.join(
      RESPONSES_BASE_PATH,
      normalizedDomain,
      "response",
      persona,
      `${action}.json`
    );

    try {
      const fileContents = readFileSync(personaPath, "utf-8");
      const parsed = JSON.parse(fileContents);
      return parsed;
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      // Fall through to default path if persona file not found
    }
  }

  // Default path (backward compatible)
  const targetPath = path.join(
    RESPONSES_BASE_PATH,
    normalizedDomain,
    "response",
    `${action}.json`
  );

  try {
    const fileContents = readFileSync(targetPath, "utf-8");
    const parsed = JSON.parse(fileContents);
    return parsed;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      console.warn(`File not found: ${targetPath}, returning empty object`);
      return {};
    }
    throw error;
  }
};

export const parseError = (error:any) => {
  if(!(error instanceof Error)){
    return null
  }

  if(isAxiosError(error)) {
    /*
    Parse onix error response
    {
      message: {
        ack: { status: 'NACK' },
        error: {
          code: 'Internal Server Error',
          message: 'Internal server error, MessageID: %!s(<nil>)'
        }
      }
    }
    */
   console.log(error.response?.data);
    return String(error.response?.data?.message?.error?.message ?? error.message)
  }

  return error.message
}


export type PricingModel = "PER_KWH" | "FIXED" | "SUBSCRIPTION" | "TIME_OF_DAY";

export interface TimeOfDayRate {
  startTime: string; // HH:mm
  endTime: string;   // HH:mm
  price: number;
}

export interface PriceCalculationParams {
  pricingModel: PricingModel;
  basePrice: number;
  quantity: number;
  wheelingCharges?: number;
  timeOfDayRates?: TimeOfDayRate[];
}

export const calculatePrice = (params: PriceCalculationParams): number => {
  const { pricingModel, basePrice, quantity, wheelingCharges = 0, timeOfDayRates } = params;
  let energyCost = 0;

  switch (pricingModel) {
    case "PER_KWH":
      energyCost = basePrice * quantity;
      break;
    case "FIXED":
    case "SUBSCRIPTION":
      energyCost = basePrice;
      break;
    case "TIME_OF_DAY":
      if (timeOfDayRates && Array.isArray(timeOfDayRates)) {
          const currentHour = new Date().getUTCHours();
          const applicableRate = timeOfDayRates.find(r => {
             const start = parseInt(r.startTime.split(":")[0]);
             const end = parseInt(r.endTime.split(":")[0]);
             return currentHour >= start && currentHour < end;
          });
          energyCost = (applicableRate?.price ?? basePrice) * quantity;
      } else {
          energyCost = basePrice * quantity;
      }
      break;
    default:
      energyCost = basePrice * quantity;
  }

  return energyCost + wheelingCharges;
}


export const calculateTotalAmount = (offer: any, quantity: number) => {
  const price = offer["beckn:price"]["schema:price"];
  const attributes = offer["beckn:offerAttributes"];

  return calculatePrice({
      basePrice: price,
      quantity,
      pricingModel: attributes?.["pricingModel"] || "PER_KWH",
      wheelingCharges: attributes?.["wheelingCharges"]?.["amount"],
      timeOfDayRates: attributes?.["timeOfDayRates"]
  });
};

// ── Gift Utilities ──────────────────────────────────────────────

const INDIAN_PHONE_RE = /^[6-9]\d{9}$/;
const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CLAIM_SECRET_LEN = 8;

const sha256 = (input: string): string =>
  crypto.createHash('sha256').update(input).digest('hex');

export function validateRecipientPhone(phone: string): void {
  if (!INDIAN_PHONE_RE.test(phone)) {
    throw new Error(
      'recipientPhone must be a 10-digit Indian mobile number starting with 6-9 (e.g. 9876543210)',
    );
  }
}

export const phoneToE164 = (phone: string): string => `+91${phone}`;

export function computeLookupHash(phone: string): string {
  validateRecipientPhone(phone);
  return sha256(phoneToE164(phone));
}

export const computeClaimVerifier = (secret: string): string => sha256(secret);

export const generateClaimSecret = (): string =>
  Array.from({ length: CLAIM_SECRET_LEN }, () =>
    ALPHANUMERIC[crypto.randomInt(ALPHANUMERIC.length)],
  ).join('');