import { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import Redis from "ioredis";
import url from "url";
import { config } from "./config";

export function initWebSocketLogServer(server: HttpServer): void {
    const wss = new WebSocketServer({ server, path: "/logs" });

    console.log("[WebSocket Log Server] Initialized at path /logs");

    wss.on("connection", (ws: WebSocket, req) => {
        const parsedUrl = url.parse(req.url || "", true);
        const deploymentId = parsedUrl.query.id as string;

        if (!deploymentId) {
            ws.send(JSON.stringify({ error: "Missing deployment ID parameter ?id=" }));
            ws.close();
            return;
        }

        console.log(`[WebSocket Log Server] Client connected for deployment ID: ${deploymentId}`);

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

        // 1. Replay any historical build logs for ultra-fast builds
        redisClient.lrange(historyKey, 0, -1, (err, logs) => {
            if (!err && logs && logs.length > 0) {
                logs.forEach((logStr) => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(logStr);
                    }
                });
            }
        });

        // 2. Subscribe to live log stream
        redisSubscriber.subscribe(channel, (err) => {
            if (err) {
                console.error(`[WebSocket Log Server] Failed to subscribe to ${channel}:`, err);
                ws.send(JSON.stringify({ error: "Failed to subscribe to build logs" }));
                return;
            }
            ws.send(JSON.stringify({ type: "info", log: `Connected to live build log stream for ${deploymentId}...` }));
        });

        redisSubscriber.on("message", (subChannel, message) => {
            if (subChannel === channel && ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        });

        ws.on("close", () => {
            console.log(`[WebSocket Log Server] Client disconnected for deployment ID: ${deploymentId}`);
            redisSubscriber.unsubscribe(channel);
            redisSubscriber.quit();
            redisClient.quit();
        });

        ws.on("error", (err) => {
            console.error(`[WebSocket Log Server] Client WS error for ${deploymentId}:`, err);
            redisSubscriber.unsubscribe(channel);
            redisSubscriber.quit();
            redisClient.quit();
        });
    });
}
