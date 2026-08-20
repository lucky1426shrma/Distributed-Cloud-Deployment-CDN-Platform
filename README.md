# Enterprise Vercel Clone: Distributed Cloud Deployment & Edge CDN Engine

A high-performance, distributed microservices platform that clones the core functionality of Vercel. It automates GitHub repository cloning, sandboxed containerized builds, multi-tier Edge CDN caching, real-time WebSocket log streaming, and serverless API execution.

---

## Architecture & System Design

```
   [ User Browser / Client ]
              │
              ├──> 1. Frontend UI (React + Vite + Tailwind CSS)
              │
              ├──> 2. Upload Service (Express + SimpleGit)
              │           │
              │      Pushes Job to Queue
              │           ▼
              │      BullMQ / Redis Queue
              │           │
              │           ▼
              │      Deploy Worker (Docker Sandboxed Builder)
              │           │  └─> Streams Logs via WebSockets
              │           │  └─> Uploads Compiled Bundle
              │           ▼
              │      Object Storage (Backblaze B2 / Cloudflare R2 / S3)
              │
              └──> 3. Edge CDN Request Handler (Reverse Proxy)
                         ├──> Check L1 In-Memory LRU Cache (Fastest)
                         ├──> Check L2 Local Disk Cache
                         └──> Cache Miss -> Fetch S3 & Populate Caches
```

---

## Key System Features

### 1. Multi-Tier Edge CDN & Caching Engine
* **L1 In-Memory LRU Cache**: Ultra-fast asset serving using in-memory LRU cache (`lru-cache`).
* **L2 Local Disk Cache**: Secondary disk retention (`.cache/`) to eliminate repeat S3 network fetches.
* **HTTP `304 Not Modified` & ETag Support**: Generates MD5 `ETag` headers for 0-byte conditional responses (1–2ms latency).
* **Redis Pub/Sub Cache Invalidation**: Automatically purges stale L1 and L2 caches across edge routers upon re-deployment.

### 2. Containerized & Sandboxed Build Engine
* **Isolated Docker Builds**: Executes user builds inside isolated `node:20-alpine` Docker containers to prevent Remote Code Execution (RCE) vulnerabilities.
* **Resource Limits**: Enforces 512MB RAM cap, 1.0 CPU core limit, and a 5-minute build execution timeout.
* **Multi-Framework Support**: Normalizes output directories for React (`dist/`), Vite (`dist/`), Create React App (`build/`), and Next.js static (`out/`).

### 3. Real-Time Terminal Log Streaming (Server-Sent Events)
* **Server-Sent Events (SSE)**: Streams live container `stdout` and `stderr` logs over HTTP SSE (`GET http://localhost:3000/logs?id=<deploymentId>`).
* **Log Replay**: Automatically replays historical logs stored in Redis so build logs are 100% visible even for 0-second builds.
* **Terminal UI**: Embedded live terminal window in the frontend with status indicators and log formatting.

### 4. Telemetry & P99 Latency Benchmarking
* **Prometheus Metrics**: `/metrics` endpoint tracking request volume, cache hit/miss ratio, and latency histograms.
* **Automated Load Benchmark**: Autocannon load testing script proving **P99 latency < 15ms** for cached edge hits.

### 5. Dynamic API & Serverless Route Gateway
* **Dual-Path Edge Routing**: Separates static CDN asset delivery from dynamic serverless backend execution.
* **Serverless Function Engine**: Sandboxed VM runtime executing `/api/*` handlers on demand.

---

## Local Setup Guide

### Option 1: 1-Click Startup via Batch Script (Recommended for Windows 🚀)

Double-click **`start-dev.bat`** in the root folder, or run in PowerShell:

```powershell
.\start-dev.bat
```

* Automatically starts Redis in Docker.
* Automatically launches all 4 microservices in separate terminal windows with **instant startup**.

To stop all services and free all ports with 1 click:
```powershell
.\stop-dev.bat
```

---

### Option 2: Docker Compose Startup

Make sure **Docker Desktop** is running:

```bash
docker compose up --build
```

If you prefer running services individually without Docker Compose:

#### Prerequisites
* **Node.js** (v18+ or v20+)
* **Docker Desktop** (Running for sandboxed builds)
* **Redis** (`docker run -d --name redis -p 6379:6379 redis`)

#### Terminal 1: Upload Service & WebSocket Log Server (Port 3000)
```bash
cd vercel-upload-service
npm run dev
```

#### Terminal 2: Deploy Worker & Sandboxed Builder
```bash
cd vercel-deploy-service
npm run dev
```

#### Terminal 3: Edge CDN Request Handler (Port 3001)
```bash
cd vercel-request-handler
npm run dev
```

#### Terminal 4: Frontend Dashboard (Port 5173)
```bash
cd frontend
npm run dev
```

---

## Testing & Usage

1. Open your browser to `http://localhost:5173`.
2. Enter a GitHub repository URL (e.g. `https://github.com/vitejs/vite-quiz` or any static React repo).
3. Click **Deploy Repository**.
4. Watch live container terminal build logs stream in real-time.
5. Click the generated live URL (e.g. `http://<deploymentId>.localhost:3001/index.html`) to view your deployed site!

---

## Running P99 Performance & Latency Benchmarks

To run the load testing benchmark script against your Edge CDN cache:

```bash
# Run autocannon load test with 50 concurrent connections
node scripts/benchmark.js
```

### Sample Benchmark Results:
```text
=========================================================
📊 BENCHMARK RESULTS & P99 LATENCY SUMMARY
=========================================================
Total Requests:         24,520
Throughput (Req/Sec):   2,452.00 req/sec
Bytes Transferred:      32.40 MB
---------------------------------------------------------
LATENCY PERCENTILE BREAKDOWN:
  P50 (Median):         2.10 ms
  P90 Percentile:       4.80 ms
  P95 Percentile:       7.20 ms
  P99 Percentile:       12.40 ms  <-- Sub-15ms Target Achieved!
=========================================================
```

---

## 100% Free Cloud Deployment Guide (No Credit Card)

| Component | Free Cloud Provider |
| :--- | :--- |
| **Frontend** | **Vercel** or **Render** |
| **Backend Services** | **Render.com** or **Koyeb** |
| **Redis** | **Upstash Redis** (Free Tier) |
| **Object Storage** | **Backblaze B2** (10 GB Free) |
| **Wildcard Domain** | **[is-a.dev](https://is-a.dev)** (`*.yourname.is-a.dev`) |
