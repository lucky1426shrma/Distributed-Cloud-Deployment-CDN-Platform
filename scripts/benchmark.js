const autocannon = require("autocannon");

async function runP99Benchmark() {
    const targetUrl = process.env.BENCHMARK_URL || "http://localhost:3001/index.html";
    const hostHeader = process.env.BENCHMARK_HOST || "test12.localhost";

    console.log("=========================================================");
    console.log("🚀 STARTING EDGE CDN P99 LATENCY & THROUGHPUT BENCHMARK");
    console.log(`Target URL: ${targetUrl}`);
    console.log(`Host Header: ${hostHeader}`);
    console.log("Connections: 50 concurrent | Duration: 10 seconds");
    console.log("=========================================================\n");

    const instance = autocannon({
        url: targetUrl,
        connections: 50,
        duration: 10,
        headers: {
            host: hostHeader,
        },
    }, (err, results) => {
        if (err) {
            console.error("Benchmark failed with error:", err);
            return;
        }

        console.log("\n=========================================================");
        console.log("📊 BENCHMARK RESULTS & P99 LATENCY SUMMARY");
        console.log("=========================================================");
        console.log(`Total Requests:         ${results.requests.total}`);
        console.log(`Throughput (Req/Sec):   ${results.requests.average.toFixed(2)} req/sec`);
        console.log(`Bytes Transferred:      ${(results.throughput.total / 1024 / 1024).toFixed(2)} MB`);
        console.log("---------------------------------------------------------");
        console.log("LATENCY PERCENTILE BREAKDOWN:");
        console.log(`  P50 (Median):         ${results.latency.p50} ms`);
        console.log(`  P90 Percentile:       ${results.latency.p90} ms`);
        console.log(`  P95 Percentile:       ${results.latency.p95} ms`);
        console.log(`  P99 Percentile:       ${results.latency.p99} ms  <-- Target < 15ms`);
        console.log("=========================================================\n");
    });

    autocannon.track(instance, { renderProgressBar: true });
}

runP99Benchmark();
