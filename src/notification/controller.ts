import { z } from "zod";

import { emailService } from "../services/email-service";
import { smsService } from "../services/sms-service";

import type { Request, Response } from "express";

const sendSmsSchema = z.object({
  phone: z.string().min(10, "Phone number is too short").regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone format"),
  message: z.string().min(1, "Message cannot be empty"),
});

export const sendSmsHandler = async (req: Request, res: Response) => {
  const validationResult = sendSmsSchema.parse(req.body);
  try {
    const { phone, message } = validationResult;

    const messageId = await smsService.sendSms(phone, message);

    return res.status(200).json({
      success: true,
      messageId,
    });
  } catch (error) {
    console.error("[NotificationController] Error sending SMS:", error);
    return res.status(500).json({ error: "Failed to send SMS" });
  }
};

const sendEmailSchema = z.object({
  to: z.string().email("Invalid email address"),
  subject: z.string().min(1, "Subject cannot be empty"),
  body: z.string().min(1, "Body cannot be empty"),
});

export const sendEmailHandler = async (req: Request, res: Response) => {
  const { to, subject, body } = sendEmailSchema.parse(req.body);
  
  try {
    const success = await emailService.sendEmail(to, subject, body);

    if (success) {
      return res.status(200).json({ success: true, message: "Email is sent successfully" });
    } else {
      return res.status(500).json({ success: false, error: "Failed to send email" });
    }
  } catch (error) {
    console.error("[NotificationController] Error sending Email:", error);
    return res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};
