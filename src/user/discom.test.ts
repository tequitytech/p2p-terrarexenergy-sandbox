import express from "express";
import request from "supertest";
import { setupTestDB, teardownTestDB, clearTestDB, getTestDB } from "../test-utils/db";
import { userRoutes } from "./routes";

// Mock the DB module
jest.mock("../db", () => ({
    getDB: () => require("../test-utils/db").getTestDB(),
}));

// Mock auth middleware (not used by this route but good for isolation)
jest.mock("../auth/routes", () => ({
    authMiddleware: (req: any, res: any, next: any) => {
        next();
    },
    normalizeIndianPhone: (phone: string) => phone,
}));

describe("DISCOM API - GET /api/discoms", () => {
    let app: express.Express;

    beforeAll(async () => {
        await setupTestDB();
    });

    afterAll(async () => {
        await teardownTestDB();
    });

    beforeEach(async () => {
        await clearTestDB();
        app = express();
        app.use(express.json());
        app.use("/api", userRoutes());
    });

    it("should return empty list when no discoms exist", async () => {
        const res = await request(app).get("/api/discoms");
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.discoms).toEqual([]);
    });

    it("should return list of discoms with correct structure", async () => {
        const db = getTestDB();
        await db.collection("discoms").insertMany([
            { name: "TPDDL", link: "https://tpddl.com", extra: "ignore" },
            { name: "BRPL", link: "https://brpl.com", extra: "ignore" }
        ]);

        const res = await request(app).get("/api/discoms");

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.discoms).toHaveLength(2);

        // Check first item
        expect(res.body.discoms[0]).toHaveProperty("name", "TPDDL");
        expect(res.body.discoms[0]).toHaveProperty("link", "https://tpddl.com");
        expect(res.body.discoms[0]).not.toHaveProperty("extra");
        expect(res.body.discoms[0]).not.toHaveProperty("_id");

        // Check second item
        expect(res.body.discoms[1]).toHaveProperty("name", "BRPL");
        expect(res.body.discoms[1]).toHaveProperty("link", "https://brpl.com");
    });

    it("should handle database errors gracefully", async () => {
        // Override the DB mock to throw
        const { getDB } = require("../db");
        const realDb = getDB();
        const origCollection = realDb.collection.bind(realDb);
        jest.spyOn(realDb, "collection").mockImplementation((...args: unknown[]) => {
            const name = args[0] as string;
            if (name === "discoms") {
                return {
                    find: () => {
                        throw new Error("DB connection failure");
                    },
                };
            }
            return origCollection(name);
        });

        // Suppress console.error for this test
        const consoleSpy = jest.spyOn(console, "error").mockImplementation();

        const res = await request(app).get("/api/discoms");
        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe("Failed to fetch discoms");

        consoleSpy.mockRestore();
        // Restore mock
        (realDb.collection as jest.Mock).mockRestore();
    });
});
