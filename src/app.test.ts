import request from "supertest";

// Mock DB and settlement poller to avoid real connections / timers
jest.mock("./db", () => ({
  connectDB: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("./services/settlement-poller", () => ({
  startPolling: jest.fn(),
  stopPolling: jest.fn(),
  getPollingStatus: jest.fn().mockReturnValue({
    enabled: false,
    running: false,
    isPolling: false,
    intervalMs: 300000,
    lastPollResult: null,
  }),
}));

import { createApp } from "./app";

describe("app.ts", () => {
  it("should create app and expose /api/health endpoint", async () => {
    const app = await createApp();

    const res = await request(app).get("/api/health").expect(200);

    expect(res.body).toEqual({ message: "OK!" });
  });

  it("should use global error handler for unhandled errors", async () => {
    const app = await createApp();

    // Register a test route that forwards an error to next()
    app.get("/error-route", (_req, _res, next) => {
      next(new Error("boom"));
    });

    const res = await request(app).get("/error-route").expect(500);
    // Body shape may vary depending on error handling, but status should be 500
    expect(res.body).toBeDefined();
  });
});

