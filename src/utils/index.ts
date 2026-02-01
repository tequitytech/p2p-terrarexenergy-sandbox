import { isAxiosError } from "axios";
import { readFileSync } from "fs";
import path from "path";

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
    return String(error.response?.data?.message?.error?.message ?? error.message)
  }

  return error.message
}