import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(__dirname, "../.env") });
dotenv.config({ path: path.join(__dirname, "../../.env") });

const rawEndpoint = process.env.S3_ENDPOINT || "";
const formattedEndpoint = rawEndpoint ? (rawEndpoint.startsWith("http") ? rawEndpoint : `https://${rawEndpoint}`) : "";

let redisHost = process.env.REDIS_HOST || "127.0.0.1";
let redisPort = parseInt(process.env.REDIS_PORT || "6379", 10);
let redisPassword = process.env.REDIS_PASSWORD || undefined;

if (process.env.REDIS_URL) {
    try {
        const redisUrl = process.env.REDIS_URL.trim();
        const u = new URL(redisUrl.startsWith("redis://") ? redisUrl : `redis://${redisUrl}`);
        if (u.hostname) redisHost = u.hostname;
        if (u.port) redisPort = parseInt(u.port, 10);
        if (u.password) redisPassword = u.password;
    } catch (err) {
        console.warn("[Config] Could not parse REDIS_URL, falling back to REDIS_HOST/REDIS_PORT:", err);
    }
}

export const config = {
    PORT: process.env.PORT || 3001,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID || "",
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY || "",
    S3_ENDPOINT: formattedEndpoint,
    S3_BUCKET_NAME: process.env.S3_BUCKET_NAME || "vercel",
    REDIS_HOST: redisHost,
    REDIS_PORT: redisPort,
    REDIS_PASSWORD: redisPassword,
};
