import { PublishCommand } from "@aws-sdk/client-sns";
import { SNSClient } from "@aws-sdk/client-sns";
import dotenv from "dotenv";
import twilio from "twilio";

import type { PublishCommandInput } from "@aws-sdk/client-sns";

dotenv.config();

export const aws_region = process.env.AWS_REGION || "us-east-1";
export const aws_access_key_id = process.env.AWS_ACCESS_KEY_ID;
export const aws_secret_access_key = process.env.AWS_SECRET_ACCESS_KEY;
export const aws_sns_sender_id = process.env.AWS_SNS_SENDER_ID;

// Twilio Config
export const twilio_sid = process.env.TWILIO_SID;
export const twilio_auth_token = process.env.TWILIO_AUTH_TOKEN;
export const twilio_sender = process.env.TWILIO_SENDER;

export const sms_provider = process.env.SMS_PROVIDER || "twilio";

if (sms_provider === "aws" && (!aws_access_key_id || !aws_secret_access_key)) {
  console.error(
    "[SNS] AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY is missing. SMS features may not work."
  );
  process.exit(1);
}

if (sms_provider === "twilio" && (!twilio_sid || !twilio_auth_token)) {
  console.error(
    "[Twilio] TWILIO_SID or TWILIO_AUTH_TOKEN is missing. SMS features may not work."
  );
  process.exit(1);
}

export const snsClient = new SNSClient({
  region: aws_region,
  credentials: {
    accessKeyId: aws_access_key_id || "",
    secretAccessKey: aws_secret_access_key || "",
  },
});

export const twilioClient =
  twilio_sid && twilio_auth_token ? twilio(twilio_sid, twilio_auth_token) : null;

export const smsService = {
  /**
   * Send an SMS using AWS SNS or Twilio based on configuration
   */
  async sendSms(phoneNumber: string, message: string): Promise<string | undefined> {
    try {
      console.log(`Sending SMS via ${sms_provider} to ${phoneNumber}`);
      if (sms_provider === "twilio") {
        if (!twilioClient) {
          throw new Error("Twilio client is not initialized");
        }
        const response = await twilioClient.messages.create({
          body: message,
          from: twilio_sender,
          to: phoneNumber,
        });
        return response.sid; // Return Twilio Message SID
      } else {
        // AWS SNS Implementation
        const params: PublishCommandInput = {
          PhoneNumber: phoneNumber,
          Message: message,
          MessageAttributes: {
            "AWS.SNS.SMS.SMSType": {
              DataType: "String",
              StringValue: "Transactional",
            },
          },
        };

        if (aws_sns_sender_id && params.MessageAttributes) {
          params.MessageAttributes["AWS.SNS.SMS.SenderID"] = {
            DataType: "String",
            StringValue: aws_sns_sender_id,
          };
        }

        const command = new PublishCommand(params);
        const response = await snsClient.send(command);
        return response.MessageId;
      }
    } catch (error) {
      console.error(`[SmsService] Error sending SMS via ${sms_provider}:`, error);
      throw error;
    }
  },
};
