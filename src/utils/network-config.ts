import { NETWORK_ID, MOCK_NETWORK_ID } from "../constants/schemas";

/**
 * Reads whitelisted mock phones from environment variables
 */
export function getMockPhones(): string[] {
    const phonesEnv = process.env.MOCK_USER_PHONES || "";
    return phonesEnv.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Checks if a phone number belongs to a whitelisted mock user
 */
export function isMockUser(phone?: string): boolean {
    if (!phone) return false;
    // normalize incoming phone by stripping +91 if present
    const normalizedPhone = phone.replace(/^\+91/, "");
    const mockPhones = getMockPhones();
    console.log(`[API] Normalized phone:`, normalizedPhone);
    console.log(`[API] Mock phones:`, mockPhones);
    return mockPhones.includes(normalizedPhone);
}

/**
 * Returns the network ID based on user environment
 * Mock users trade on "p2p-mock-network"
 * Prod users trade on the global NETWORK_ID (e.g. "p2p-interdiscom-trading-pilot-network")
 */
export function getNetworkId(phone?: string): string {
    if (isMockUser(phone)) {
        console.log(`[API] User is mock`,MOCK_NETWORK_ID);
        return MOCK_NETWORK_ID;
    }
    console.log(`[API] User is prod`,NETWORK_ID);
    return NETWORK_ID;
}

/**
 * Resolves the discom name for the user
 * Mock: uses a TEST prefix or TEST_PVVNL specifically
 * Prod: Uses actual discom exactly as it is without modifications
 */
export function resolveDiscom(
    phone: string | undefined,
    originalDiscom: string,
    role: "BUYER" | "SELLER"
): string {
    if (isMockUser(phone)) {
        //we need to use only PVVNL as mention on instrudction

        // if (originalDiscom) {
        // return "TEST_PVVNL";
        // }
        console.log(`[API] User is mock`, `TEST_DISCOM_${role}`);
        return `TEST_DISCOM_${role}`;
    }
    // Production users trade on their actual network discom
    console.log(`[API] User is prod`, originalDiscom);
    return originalDiscom;
}

/**
 * Resolves the meter ID for the user
 * Mock: uses a TEST prefix or generic TEST fallback
 * Prod: Uses actual meter exactly as it is without modifications
 */
export function resolveMeter(
    phone: string | undefined,
    originalMeter: string,
    role: "BUYER" | "SELLER"
): string {
    if (isMockUser(phone)) {
        console.log(`[API] User is mock`, `TEST_METER_${role}`, '--Meter id is:-', originalMeter);
        return `TEST_METER_${role}`;
    }
    // Production users trade on their actual network meter
    console.log(`[API] User is prod`, originalMeter);
    return originalMeter;
}
