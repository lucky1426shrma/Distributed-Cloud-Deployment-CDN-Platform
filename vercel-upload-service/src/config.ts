import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(__dirname, "../.env") });
dotenv.config({ path: path.join(__dirname, "../../.env") });

const rawEndpoint = process.env.S3_ENDPOINT || "";
const formattedEndpoint = rawEndpoint ? (rawEndpoint.startsWith("http") ? rawEndpoint : `https://${rawEndpoint}`) : "";

export const config = {
    PORT: process.env.PORT || 3000,
    REDIS_HOST: process.env.REDIS_HOST || "127.0.0.1",
    REDIS_PORT: parseInt(process.env.REDIS_PORT || "6379", 10),
    REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID || "",
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY || "",
    S3_ENDPOINT: formattedEndpoint,
    S3_BUCKET_NAME: process.env.S3_BUCKET_NAME || "vercel",
};
