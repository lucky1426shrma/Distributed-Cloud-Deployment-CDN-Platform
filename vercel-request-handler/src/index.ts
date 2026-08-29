import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";
import { S3 } from "aws-sdk";
import { config } from "./config";
import { getL1, setL1, getL2, setL2, computeETag, CacheEntry } from "./cdnCache";
import { initPurgeSubscriber } from "./purgeSubscriber";
import { getMetrics, getMetricsContentType, httpRequestCounter, httpRequestDuration } from "./metrics";
import { executeServerlessFunction, FunctionResponse } from "./functionRunner";

const s3Config: S3.ClientConfiguration = {
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    signatureVersion: "v4",
};

if (config.S3_ENDPOINT) {
    s3Config.endpoint = config.S3_ENDPOINT;
}

export const s3 = new S3(s3Config);
const app = express();

app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "x-deployment-id", "If-None-Match"],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Redis Pub/Sub listener for instant cache invalidation
initPurgeSubscriber();

// Prometheus Metrics Endpoint
app.get("/metrics", async (req, res) => {
    try {
        res.set("Content-Type", getMetricsContentType());
        res.end(await getMetrics());
    } catch (err: any) {
        res.status(500).end(err.message);
    }
});

// Helper for MIME types
function getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case ".html": return "text/html; charset=UTF-8";
        case ".css": return "text/css; charset=UTF-8";
        case ".js":
        case ".mjs": return "application/javascript; charset=UTF-8";
        case ".json":
        case ".map": return "application/json";
        case ".svg": return "image/svg+xml";
        case ".png": return "image/png";
        case ".jpg":
        case ".jpeg": return "image/jpeg";
        case ".gif": return "image/gif";
        case ".webp": return "image/webp";
        case ".avif": return "image/avif";
        case ".ico": return "image/x-icon";
        case ".woff2": return "font/woff2";
        case ".woff": return "font/woff";
        case ".ttf": return "font/ttf";
        case ".otf": return "font/otf";
        case ".wasm": return "application/wasm";
        case ".mp4": return "video/mp4";
        case ".webm": return "video/webm";
        case ".txt": return "text/plain; charset=UTF-8";
        case ".xml": return "application/xml";
        default: return "application/octet-stream";
    }
}

// Dynamic API & Static File Router
app.all("/*", async (req, res) => {
    const startTime = Date.now();
    const host = req.hostname;
    let id = host.split(".")[0];

    // Fallback: If hosted on a cloud domain like onrender.com without wildcard subdomains
    if (req.query.id) {
        id = req.query.id as string;
    } else if (req.query.__id) {
        id = req.query.__id as string;
    } else if (req.headers["x-deployment-id"]) {
        id = req.headers["x-deployment-id"] as string;
    }

    const rawPath = req.path === "/" ? "/index.html" : req.path;

    // Helper to send serverless response
    const sendServerlessResponse = (funcResult: FunctionResponse) => {
        Object.entries(funcResult.headers || {}).forEach(([headerName, headerVal]) => {
            res.set(headerName, headerVal);
        });
        const durationSec = (Date.now() - startTime) / 1000;
        httpRequestCounter.inc({ cache_status: "DYNAMIC-API", status_code: funcResult.statusCode.toString() });
        httpRequestDuration.observe({ cache_status: "DYNAMIC-API", status_code: funcResult.statusCode.toString() }, durationSec);
        return res.status(funcResult.statusCode).send(funcResult.body);
    };

    // 1. Explicit Dynamic API route (/api/* or /api)
    if (rawPath === "/api" || rawPath.startsWith("/api/")) {
        console.log(`[CDN Router] Routing dynamic Serverless API request '${req.method} ${rawPath}' for deployment ${id}...`);
        try {
            const funcResult = await executeServerlessFunction(
                id,
                rawPath,
                req.method,
                req.body,
                req.query,
                req.headers
            );
            return sendServerlessResponse(funcResult);
        } catch (err: any) {
            console.error(`[CDN Router] Serverless API Execution Error for ${id} ${rawPath}:`, err);
            return res.status(500).json({ error: "Internal Serverless Function Execution Error", details: err.message });
        }
    }

    // 2. Non-file routes (e.g. /users, /products, /auth/login) - Check if serverless function handles it
    const isStaticAssetWithExtension = /\.(html|css|js|mjs|json|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|otf|webp|avif|wasm|mp4|webm|map|txt|xml)$/i.test(rawPath);
    const localFunctionExists = fs.existsSync(path.join(__dirname, "../.functions", id));

    if (!isStaticAssetWithExtension || localFunctionExists) {
        try {
            const funcResult = await executeServerlessFunction(
                id,
                rawPath,
                req.method,
                req.body,
                req.query,
                req.headers
            );

            // If a real route handled the request (not the fallback message), return dynamic API response
            const isFallbackMessage = funcResult.body && typeof funcResult.body === "object" && funcResult.body.message && funcResult.body.message.startsWith("Serverless API Route");
            if (funcResult.body && !isFallbackMessage) {
                console.log(`[CDN Router] Serverless backend handled route '${req.method} ${rawPath}' directly.`);
                return sendServerlessResponse(funcResult);
            }
        } catch {}
    }

    // Static Asset Handling (CDN L1/L2 Cache + S3 Fetch)
    const key = `dist/${id}${rawPath}`;
    const clientETag = req.headers["if-none-match"];

    const recordMetrics = (cacheStatus: "HIT-L1" | "HIT-L2" | "MISS", statusCode: number) => {
        const durationSec = (Date.now() - startTime) / 1000;
        httpRequestCounter.inc({ cache_status: cacheStatus, status_code: statusCode.toString() });
        httpRequestDuration.observe({ cache_status: cacheStatus, status_code: statusCode.toString() }, durationSec);
    };

    // Helper to send cached entry with proper HTTP headers
    const sendCachedEntry = (entry: CacheEntry, cacheStatus: "HIT-L1" | "HIT-L2") => {
        const responseTime = Date.now() - startTime;
        res.set("X-Cache", cacheStatus);
        res.set("X-Response-Time", `${responseTime}ms`);
        res.set("ETag", entry.etag);
        res.set("Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=60");
        res.set("Content-Type", entry.contentType);

        if (clientETag && clientETag === entry.etag) {
            console.log(`[CDN Router] 304 Not Modified (${cacheStatus}) for ${key} [${responseTime}ms]`);
            recordMetrics(cacheStatus, 304);
            return res.status(304).end();
        }

        console.log(`[CDN Router] 200 OK (${cacheStatus}) for ${key} [${responseTime}ms]`);
        recordMetrics(cacheStatus, 200);
        return res.send(entry.body);
    };

    // 1. Check L1 In-Memory LRU Cache
    const l1Hit = getL1(key);
    if (l1Hit) {
        return sendCachedEntry(l1Hit, "HIT-L1");
    }

    // 2. Check L2 Local Disk Cache
    const l2Hit = getL2(key);
    if (l2Hit) {
        return sendCachedEntry(l2Hit, "HIT-L2");
    }

    // 3. Cache Miss -> Fetch from S3/Backblaze B2 Object Storage
    try {
        console.log(`[CDN Router] Cache MISS for ${key}. Fetching from S3 bucket ${config.S3_BUCKET_NAME}...`);
        
        let contents;
        try {
            contents = await s3.getObject({
                Bucket: config.S3_BUCKET_NAME,
                Key: key,
            }).promise();
        } catch (s3Err: any) {
            // Clean URL & SPA Fallback:
            // 1. If user visits /about (no extension), try dist/${id}/about.html
            // 2. Otherwise fallback to dist/${id}/index.html for React SPA
            if (!rawPath.includes(".")) {
                try {
                    const cleanHtmlKey = `dist/${id}${rawPath}.html`;
                    contents = await s3.getObject({
                        Bucket: config.S3_BUCKET_NAME,
                        Key: cleanHtmlKey,
                    }).promise();
                } catch {
                    const fallbackKey = `dist/${id}/index.html`;
                    contents = await s3.getObject({
                        Bucket: config.S3_BUCKET_NAME,
                        Key: fallbackKey,
                    }).promise();
                }
            } else if (rawPath.endsWith(".html")) {
                const fallbackKey = `dist/${id}/index.html`;
                contents = await s3.getObject({
                    Bucket: config.S3_BUCKET_NAME,
                    Key: fallbackKey,
                }).promise();
            } else {
                throw s3Err;
            }
        }

        const body = contents.Body as Buffer;
        const etag = computeETag(body);
        const contentType = !rawPath.includes(".") ? "text/html; charset=UTF-8" : getMimeType(rawPath);

        const entry: CacheEntry = {
            body,
            contentType,
            etag,
            size: body.length,
        };

        // Populate L1 & L2 Caches
        setL1(key, entry);
        setL2(key, entry);

        const responseTime = Date.now() - startTime;
        res.set("X-Cache", "MISS");
        res.set("X-Response-Time", `${responseTime}ms`);
        res.set("ETag", etag);
        res.set("Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=60");
        res.set("Content-Type", contentType);

        if (clientETag && clientETag === etag) {
            console.log(`[CDN Router] 304 Not Modified (MISS populated) for ${key} [${responseTime}ms]`);
            recordMetrics("MISS", 304);
            return res.status(304).end();
        }

        console.log(`[CDN Router] 200 OK (MISS -> S3 fetched & cached) for ${key} [${responseTime}ms]`);
        recordMetrics("MISS", 200);
        return res.send(body);
    } catch (err: any) {
        const responseTime = Date.now() - startTime;
        console.error(`[CDN Router] 404 Not Found for ${key} [${responseTime}ms]:`, err.message);
        recordMetrics("MISS", 404);
        return res.status(404).send("404 Deployment Asset Not Found.");
    }
});

app.listen(config.PORT, () => {
    console.log(`[Request Handler] Enterprise CDN Edge Router running on port ${config.PORT}`);
});