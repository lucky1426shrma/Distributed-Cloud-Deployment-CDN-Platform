import express from "express";
import cors from "cors";
import simpleGit from "simple-git";
import path from "path";
import Redis from "ioredis";
import { generate } from "./utils";
import { getAllFiles } from "./file";
import { uploadFile } from "./aws";
import { config } from "./config";
import { buildQueue, redisConnection } from "./queue";
import { setupSSELogStream } from "./sseLogs";

const redisClient = new Redis(redisConnection);

const app = express();
app.use(cors());
app.use(express.json());

// Setup Server-Sent Events (SSE) build log stream endpoint (/logs?id=...)
setupSSELogStream(app);

app.post("/deploy", async (req, res) => {
    const repoUrl = req.body.repoUrl;
    if (!repoUrl) {
        return res.status(400).json({ error: "repoUrl is required" });
    }

    const id = generate();
    const outputPath = path.join(__dirname, `output/${id}`);

    try {
        console.log(`[Upload Service] Fast shallow cloning repo ${repoUrl} to ${outputPath}...`);
        await simpleGit().clone(repoUrl, outputPath, ["--depth=1"]);

        const files = getAllFiles(outputPath);
        console.log(`[Upload Service] Uploading ${files.length} source files in parallel for ID ${id}...`);

        // Upload all source files concurrently to Backblaze B2/S3
        await Promise.all(
            files.map(file => {
                const s3Key = file.slice(__dirname.length + 1).replace(/\\/g, "/");
                return uploadFile(s3Key, file);
            })
        );

        await buildQueue.add("build-job", { id, repoUrl }, { jobId: id });
        await redisClient.hset("status", id, "uploaded");

        console.log(`[Upload Service] Deployment ${id} successfully enqueued in BullMQ build-queue.`);

        return res.json({ id });
    } catch (err: any) {
        console.error(`[Upload Service] Error handling deployment ${id}:`, err);
        await redisClient.hset("status", id, "failed");
        return res.status(500).json({ error: err.message || "Failed to process deployment" });
    }
});

app.get("/status", async (req, res) => {
    const id = req.query.id as string;
    if (!id) {
        return res.status(400).json({ error: "id parameter is required" });
    }

    try {
        const status = await redisClient.hget("status", id);
        return res.json({ id, status: status || "not_found" });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

app.listen(config.PORT, () => {
    console.log(`[Upload Service] Server with SSE log stream running on port ${config.PORT}`);
});
