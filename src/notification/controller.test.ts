import { Request, Response } from "express";
import { sendSmsHandler, sendEmailHandler } from "./controller";
import { smsService } from "../services/sms-service";
import { emailService } from "../services/email-service";

// Mock the services
jest.mock("../services/sms-service", () => ({
  smsService: {
    sendSms: jest.fn(),
  },
}));

jest.mock("../services/email-service", () => ({
  emailService: {
    sendEmail: jest.fn()
  }
}));

// Helper to create mock Request
const mockRequest = (body: any): Partial<Request> => ({ body });

// Helper to create mock Response
const mockResponse = (): Partial<Response> => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe("Notification Controller", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("sendSmsHandler", () => {
    it("should throw validation error (invalid phone)", async () => {
      const req = mockRequest({ phone: "invalid-phone", message: "Test SMS" });
      const res = mockResponse();

      await expect(sendSmsHandler(req as Request, res as Response)).rejects.toThrow();
    });

    it("should throw validation error (missing message)", async () => {
      const req = mockRequest({ phone: "+1234567890" });
      const res = mockResponse();

      await expect(sendSmsHandler(req as Request, res as Response)).rejects.toThrow();
    });

    it("should return 200 and messageId on success", async () => {
      const req = mockRequest({ phone: "+1234567890", message: "Test SMS" });
      const res = mockResponse();

      (smsService.sendSms as jest.Mock).mockResolvedValue("msg-id-123");

      await sendSmsHandler(req as Request, res as Response);

      expect(smsService.sendSms).toHaveBeenCalledWith("+1234567890", "Test SMS");
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        messageId: "msg-id-123",
      });
    });

    it("should return 500 if service throws error", async () => {
      const req = mockRequest({ phone: "+1234567890", message: "Test SMS" });
      const res = mockResponse();

      (smsService.sendSms as jest.Mock).mockRejectedValue(new Error("SNS Fail"));

      await sendSmsHandler(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: "Failed to send SMS",
      });
    });
  });

  describe("sendEmailHandler", () => {
    it("should return 200 on successful email sent", async () => {
      const req = mockRequest({ to: "test@example.com", subject: "Hello", body: "World" });
      const res = mockResponse();

      (emailService.sendEmail as jest.Mock).mockResolvedValue(true);

      await sendEmailHandler(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true
      }));
    });

    it("should throw validation error for invalid email", async () => {
      const req = mockRequest({ to: "invalid", subject: "S", body: "B" });
      const res = mockResponse();

      await expect(sendEmailHandler(req as Request, res as Response)).rejects.toThrow();
    });

    it("should return 500 if email service fails", async () => {
      const req = mockRequest({ to: "test@example.com", subject: "S", body: "B" });
      const res = mockResponse();

      (emailService.sendEmail as jest.Mock).mockResolvedValue(false);

      await sendEmailHandler(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    });
  });
});
