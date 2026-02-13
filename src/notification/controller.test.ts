import express from "express";
import request from "supertest";
import { ZodError } from "zod";

import { smsService } from "../services/sms-service";
import { emailService } from "../services/email-service";
import { notificationService } from "../services/notification-service";

import { sendSmsHandler, sendEmailHandler, markAsReadHandler } from "./controller";

// Mock the smsService
jest.mock("../services/sms-service", () => ({
  smsService: {
    sendSms: jest.fn(),
  },
}));

// Mock the emailService
jest.mock("../services/email-service", () => ({
  emailService: {
    sendEmail: jest.fn(),
  },
}));

jest.mock("../services/notification-service", () => ({
  notificationService: {
    markAsRead: jest.fn(),
    markAllAsRead: jest.fn(),
  },
}));

/**
 * sendSmsHandler and sendEmailHandler call schema.parse() OUTSIDE their try/catch block,
 * so ZodError propagates as an unhandled exception. In production, the
 * Express global error handler (app.ts) catches ZodError and returns 400.
 * We replicate that here with a mini Express app + the same error handler.
 */
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.post("/notification/sms", sendSmsHandler);
  app.post("/notification/email", sendEmailHandler);

  // Mock authentication middleware
  app.use((req: any, _res, next) => {
    req.user = { userId: "507f1f77bcf86cd799439011" }; // Valid ObjectId
    next();
  });

  app.put("/notification/:id/read", markAsReadHandler);

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

    it("should return 400 when phone is empty string", async () => {
      const res = await request(app)
        .post("/notification/sms")
        .send({ phone: "", message: "Test SMS" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("should return 400 when request body has no fields", async () => {
      const res = await request(app)
        .post("/notification/sms")
        .set("Content-Type", "application/json")
        .send("{}");

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("should accept valid international phone formats", async () => {
      (smsService.sendSms as jest.Mock).mockResolvedValue("msg-intl-001");

      const res = await request(app)
        .post("/notification/sms")
        .send({ phone: "+919876543210", message: "International SMS" });

      expect(res.status).toBe(200);
      expect(smsService.sendSms).toHaveBeenCalledWith("+919876543210", "International SMS");
      expect(res.body.success).toBe(true);
    });

    it("should return specific validation errors for each invalid field", async () => {
      // Both phone and message are invalid (empty body object)
      const res = await request(app)
        .post("/notification/sms")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.details.length).toBeGreaterThanOrEqual(1);
      // At least one field should have a validation error
      const fields = res.body.error.details.map((d: any) => d.field);
      expect(fields).toContain("phone");
    });
  });

  describe("sendEmailHandler", () => {
    it("should return 200 on successful email send", async () => {
      (emailService.sendEmail as jest.Mock).mockResolvedValue(true);

      const res = await request(app)
        .post("/notification/email")
        .send({ to: "user@example.com", subject: "Test Subject", body: "Test Body" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: "Email is sent successfully",
      });
      expect(emailService.sendEmail).toHaveBeenCalledWith(
        "user@example.com",
        "Test Subject",
        "Test Body"
      );
    });

    it("should return 500 when emailService.sendEmail returns false", async () => {
      (emailService.sendEmail as jest.Mock).mockResolvedValue(false);

      const res = await request(app)
        .post("/notification/email")
        .send({ to: "user@example.com", subject: "Test Subject", body: "Test Body" });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        success: false,
        error: "Failed to send email",
      });
    });

    it("should return 500 when emailService throws an error", async () => {
      (emailService.sendEmail as jest.Mock).mockRejectedValue(new Error("SMTP connection failed"));

      const res = await request(app)
        .post("/notification/email")
        .send({ to: "user@example.com", subject: "Test Subject", body: "Test Body" });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        success: false,
        error: "Internal Server Error",
      });
    });

    it("should return 400 when 'to' field is missing", async () => {
      const res = await request(app)
        .post("/notification/email")
        .send({ subject: "Test Subject", body: "Test Body" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      const toError = res.body.error.details.find((d: any) => d.field === "to");
      expect(toError).toBeDefined();
    });

    it("should return 400 when 'to' is not a valid email", async () => {
      const res = await request(app)
        .post("/notification/email")
        .send({ to: "not-an-email", subject: "Test Subject", body: "Test Body" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      const toError = res.body.error.details.find((d: any) => d.field === "to");
      expect(toError).toBeDefined();
      expect(toError.message).toMatch(/email/i);
    });

    it("should return 400 when subject is empty string", async () => {
      const res = await request(app)
        .post("/notification/email")
        .send({ to: "user@example.com", subject: "", body: "Test Body" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      const subjectError = res.body.error.details.find((d: any) => d.field === "subject");
      expect(subjectError).toBeDefined();
    });

    it("should return 400 when body is empty string", async () => {
      const res = await request(app)
        .post("/notification/email")
        .send({ to: "user@example.com", subject: "Test Subject", body: "" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      const bodyError = res.body.error.details.find((d: any) => d.field === "body");
      expect(bodyError).toBeDefined();
    });

    it("should return 400 when all fields are missing", async () => {
      const res = await request(app)
        .post("/notification/email")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.details.length).toBeGreaterThanOrEqual(1);
    });

    it("should return 400 when subject field is missing", async () => {
      const res = await request(app)
        .post("/notification/email")
        .send({ to: "user@example.com", body: "Test Body" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      const subjectError = res.body.error.details.find((d: any) => d.field === "subject");
      expect(subjectError).toBeDefined();
    });

    it("should return 400 when body field is missing", async () => {
      const res = await request(app)
        .post("/notification/email")
        .send({ to: "user@example.com", subject: "Test Subject" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      const bodyError = res.body.error.details.find((d: any) => d.field === "body");
      expect(bodyError).toBeDefined();
    });
  });

  describe("markAsReadHandler", () => {
    it("should mark all as read when id is 'all'", async () => {
      const res = await request(app).put("/notification/all/read");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(notificationService.markAllAsRead).toHaveBeenCalled();
    });

    it("should mark specific notification as read when id is valid ObjectId", async () => {
      const validId = "609c15d482271844b829c66e";
      const res = await request(app).put(`/notification/${validId}/read`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(notificationService.markAsRead).toHaveBeenCalledWith(validId, expect.anything());
    });

    it("should return 400 when id is invalid ObjectId", async () => {
      const invalidId = "invalid-id";
      const res = await request(app).put(`/notification/${invalidId}/read`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Invalid notification ID");
      expect(notificationService.markAsRead).not.toHaveBeenCalled();
    });
  });
});
