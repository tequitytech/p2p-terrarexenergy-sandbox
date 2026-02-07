import { PublishCommand } from "@aws-sdk/client-sns";
import { SNSClient } from "@aws-sdk/client-sns";
import dotenv from "dotenv";

import type { PublishCommandInput } from "@aws-sdk/client-sns";

dotenv.config();

export const aws_region = process.env.AWS_REGION || "us-east-1";
export const aws_access_key_id = process.env.AWS_ACCESS_KEY_ID;
export const aws_secret_access_key = process.env.AWS_SECRET_ACCESS_KEY;
export const aws_sns_sender_id = process.env.AWS_SNS_SENDER_ID;

if (!aws_access_key_id || !aws_secret_access_key) {
  console.warn(
    "[SNS] AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY is missing. SMS features may not work."
  );
}

export const snsClient = new SNSClient({
  region: aws_region,
  credentials: {
    accessKeyId: aws_access_key_id || "",
    secretAccessKey: aws_secret_access_key || "",
  },
});


export const smsService = {
  /**
   * Send an SMS using AWS SNS
   */
  async sendSms(phoneNumber: string, message: string): Promise<string | undefined> {
    try {
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
    } catch (error) {
      console.error("[SmsService] Error sending SMS:", error);
      throw error;
    }
  },
};
