import { Express, Request, Response } from "express";
import Redis from "ioredis";
import { config } from "./config";

export function setupSSELogStream(app: Express): void {
    app.get("/logs", (req: Request, res: Response) => {
        const deploymentId = req.query.id as string;

        if (!deploymentId) {
            return res.status(400).json({ error: "Missing deployment ID parameter ?id=" });
        }

        // Set headers for Server-Sent Events (SSE)
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.flushHeaders();

        console.log(`[SSE Log Stream] Client connected for deployment ID: ${deploymentId}`);

        const redisClient = new Redis({
            host: config.REDIS_HOST,
            port: config.REDIS_PORT,
            password: config.REDIS_PASSWORD,
        });

        const redisSubscriber = new Redis({
            host: config.REDIS_HOST,
            port: config.REDIS_PORT,
            password: config.REDIS_PASSWORD,
        });

        const channel = `build-logs:${deploymentId}`;
        const historyKey = `build-logs-history:${deploymentId}`;

        // 1. Replay historical logs stored in Redis
        redisClient.lrange(historyKey, 0, -1, (err, logs) => {
            if (!err && logs && logs.length > 0) {
                logs.forEach((logStr) => {
                    res.write(`data: ${logStr}\n\n`);
                });
            }
        });

        // 2. Subscribe to live Redis build logs channel
        redisSubscriber.subscribe(channel, (err) => {
            if (err) {
                console.error(`[SSE Log Stream] Failed to subscribe to ${channel}:`, err);
                res.write(`data: ${JSON.stringify({ type: "stderr", log: "Failed to subscribe to build logs" })}\n\n`);
                return;
            }
            res.write(`data: ${JSON.stringify({ type: "info", log: `Connected to SSE live build stream for ${deploymentId}...` })}\n\n`);
        });

        redisSubscriber.on("message", (subChannel, message) => {
            if (subChannel === channel) {
                res.write(`data: ${message}\n\n`);
            }
        });

        // Clean up connections when client disconnects
        req.on("close", () => {
            console.log(`[SSE Log Stream] Client disconnected for deployment ID: ${deploymentId}`);
            redisSubscriber.unsubscribe(channel);
            redisSubscriber.quit();
            redisClient.quit();
        });
    });
}
