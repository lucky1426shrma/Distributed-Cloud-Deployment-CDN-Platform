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

app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "x-deployment-id"],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get("/", (req, res) => {
    res.json({ service: "vercel-upload-service", status: "healthy", timestamp: new Date().toISOString() });
});

app.get("/health", (req, res) => {
    res.json({ service: "vercel-upload-service", status: "healthy" });
});

// Setup Server-Sent Events (SSE) build log stream endpoint (/logs/:id)
setupSSELogStream(app);

app.post("/deploy", async (req, res) => {
    let { repoUrl, deploymentType = "auto", rootDirectory = "" } = req.body;
    if (!repoUrl) {
        return res.status(400).json({ error: "repoUrl is required" });
    }

    // Support GitHub subfolder URLs (e.g. https://github.com/user/repo/tree/main/frontend)
    if (repoUrl.includes("/tree/")) {
        const parts = repoUrl.split("/tree/");
        const cleanRepoUrl = parts[0];
        const subParts = parts[1].split("/"); // branch/subfolder...
        subParts.shift(); // remove branch (e.g. main/master)
        if (subParts.length > 0 && !rootDirectory) {
            rootDirectory = subParts.join("/");
        }
        repoUrl = cleanRepoUrl;
    }

    const id = generate();
    const outputPath = path.join(__dirname, `output/${id}`);

    try {
        console.log(`[Upload Service] Fast shallow cloning repo ${repoUrl} (Subfolder: '${rootDirectory}') to ${outputPath}...`);
        await simpleGit().clone(repoUrl, outputPath, ["--depth=1"]);

        const files = getAllFiles(outputPath);
        console.log(`[Upload Service] Uploading ${files.length} source files in parallel for ID ${id}...`);

        await Promise.all(
            files.map(file => {
                const s3Key = file.slice(__dirname.length + 1).replace(/\\/g, "/");
                return uploadFile(s3Key, file);
            })
        );

        await buildQueue.add("build-job", { id, repoUrl, deploymentType, rootDirectory }, { jobId: id });
        await redisClient.hset("status", id, "uploaded");

        console.log(`[Upload Service] Deployment ${id} (Subfolder: '${rootDirectory}') enqueued in BullMQ build-queue.`);

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
