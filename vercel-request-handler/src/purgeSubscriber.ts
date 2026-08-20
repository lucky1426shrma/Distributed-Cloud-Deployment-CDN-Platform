import Redis from "ioredis";
import { config } from "./config";
import { purgeDeploymentCache } from "./cdnCache";

export function initPurgeSubscriber(): void {
    const subscriber = new Redis({
        host: config.REDIS_HOST,
        port: config.REDIS_PORT,
        password: config.REDIS_PASSWORD,
    });

    subscriber.subscribe("cache-purge", (err, count) => {
        if (err) {
            console.error("[CDN Purge Subscriber] Failed to subscribe to cache-purge channel:", err);
            return;
        }
        console.log(`[CDN Purge Subscriber] Subscribed to cache-purge channel. Listening for cache invalidation events.`);
    });

    subscriber.on("message", (channel, message) => {
        if (channel === "cache-purge") {
            try {
                const data = JSON.parse(message);
                if (data && data.id) {
                    console.log(`[CDN Purge Subscriber] Received purge event for deployment ID: ${data.id}`);
                    purgeDeploymentCache(data.id);
                }
            } catch (err) {
                console.error("[CDN Purge Subscriber] Invalid purge message received:", message, err);
            }
        }
    });
}
