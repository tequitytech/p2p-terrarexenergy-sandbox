import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";

const BUCKET_NAME = process.env.AWS_BUCKET_NAME || "";
const REGION = process.env.AWS_REGION || "us-east-1";

// Initialize S3 Client
const s3Config: any = {
    region: REGION,
};

if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    s3Config.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
}

const s3Client = new S3Client(s3Config);

export const S3Service = {
    /**
     * Uploads a file buffer to S3 and returns the public URL or Key
     * @param fileBuffer The file content as buffer
     * @param mimeType MIME type of the file
     * @returns {Promise<string>} The Key of the uploaded file
     */
    async uploadFile(fileBuffer: Buffer, mimeType: string, folder: string): Promise<string> {
        if (!BUCKET_NAME) {
            throw new Error("AWS_BUCKET_NAME is not configured");
        }

        const key = `${folder}/images/${uuidv4()}-${Date.now()}`;

        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Body: fileBuffer,
            ContentType: mimeType,
        });

        try {
            await s3Client.send(command);
            return key;
        } catch (error) {
            console.error("Error uploading to S3:", error);
            throw new Error("Failed to upload image to S3");
        }
    },
};
