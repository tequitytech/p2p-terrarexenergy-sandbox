import express from "express";
import request from "supertest";
import { sendSmsHandler } from "./controller";
import { smsService } from "../services/sms-service";
import { ZodError } from "zod";

// Mock the smsService
jest.mock("../services/sms-service", () => ({
  smsService: {
    sendSms: jest.fn(),
  },
}));

/**
 * sendSmsHandler calls sendSmsSchema.parse() OUTSIDE its try/catch block,
 * so ZodError propagates as an unhandled exception. In production, the
 * Express global error handler (app.ts) catches ZodError and returns 400.
 * We replicate that here with a mini Express app + the same error handler.
 */
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.post("/notification/sms", sendSmsHandler);

  // Replicate the global ZodError handler from app.ts
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: err.issues[0]?.message || "Request validation failed",
          details: err.issues.map((e: any) => ({
            field: e.path.join("."),
            message: e.message,
          })),
        },
      });
    }
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}

describe("Notification Controller", () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createTestApp();
  });

  describe("sendSmsHandler", () => {
    it("should return 400 with validation details when phone format is invalid", async () => {
      const res = await request(app)
        .post("/notification/sms")
        .send({ phone: "invalid-phone", message: "Test SMS" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      // Verify the error details mention the phone field
      const phoneError = res.body.error.details.find(
        (d: any) => d.field === "phone"
      );
      expect(phoneError).toBeDefined();
      expect(phoneError.message).toMatch(/phone/i);
    });

    it("should return 400 with validation details when message field is missing", async () => {
      const res = await request(app)
        .post("/notification/sms")
        .send({ phone: "+1234567890" }); // Missing message

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      // Verify the error details mention the message field
      const messageError = res.body.error.details.find(
        (d: any) => d.field === "message"
      );
      expect(messageError).toBeDefined();
    });

    it("should return 200 and messageId on success", async () => {
      (smsService.sendSms as jest.Mock).mockResolvedValue("msg-id-123");

      const res = await request(app)
        .post("/notification/sms")
        .send({ phone: "+1234567890", message: "Test SMS" });

      expect(smsService.sendSms).toHaveBeenCalledWith("+1234567890", "Test SMS");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        messageId: "msg-id-123",
      });
    });

    it("should return 500 if service throws error", async () => {
      (smsService.sendSms as jest.Mock).mockRejectedValue(new Error("SNS Fail"));

      const res = await request(app)
        .post("/notification/sms")
        .send({ phone: "+1234567890", message: "Test SMS" });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: "Failed to send SMS",
      });
    });
  });
});
