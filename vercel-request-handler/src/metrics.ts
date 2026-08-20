import client from "prom-client";

// Collect default Node.js process metrics (CPU, Memory, Event Loop Lag)
client.collectDefaultMetrics({ prefix: "vercel_cdn_" });

export const httpRequestCounter = new client.Counter({
    name: "vercel_cdn_http_requests_total",
    help: "Total number of HTTP requests processed by Edge CDN router",
    labelNames: ["cache_status", "status_code"],
});

export const httpRequestDuration = new client.Histogram({
    name: "vercel_cdn_http_request_duration_seconds",
    help: "HTTP request latency duration histogram in seconds",
    labelNames: ["cache_status", "status_code"],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

export async function getMetrics(): Promise<string> {
    return client.register.metrics();
}

export function getMetricsContentType(): string {
    return client.register.contentType;
}
