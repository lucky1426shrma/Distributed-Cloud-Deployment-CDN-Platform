import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { downloadS3Folder, copyFinalDist } from "./aws";
import { config } from "./config";
import { publishBuildLog, buildProjectInDocker } from "./builder";

const redisConnection = {
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
};

const redisClient = new Redis(redisConnection);

console.log("[Deploy Service] Initializing BullMQ Worker for build-queue...");

const worker = new Worker(
    "build-queue",
    async (job: Job<{ id: string; repoUrl?: string; deploymentType?: string; rootDirectory?: string }>) => {
        const { id, deploymentType = "auto", rootDirectory = "" } = job.data;
        console.log(`[Deploy Service] Processing build job ${job.id} for ID ${id} (Subfolder: '${rootDirectory}')...`);

        try {
            await redisClient.hset("status", id, "building");
            await publishBuildLog(id, `Worker picked up job. Subfolder: '${rootDirectory || "."}'. Downloading S3 files...`, "info", "building");

            console.log(`[Deploy Service] Downloading S3 source files for ${id}...`);
            await downloadS3Folder(`output/${id}`);

            console.log(`[Deploy Service] Building project for ${id} (Subfolder: '${rootDirectory}')...`);
            await buildProjectInDocker({ id, deploymentType, rootDirectory });

            console.log(`[Deploy Service] Uploading compiled dist files for ${id}...`);
            await publishBuildLog(id, `Uploading compiled dist files & serverless functions to S3...`, "info");
            await copyFinalDist(id, rootDirectory);

            await redisClient.hset("status", id, "deployed");
            await publishBuildLog(id, `Deployment successfully built and deployed to Edge CDN!`, "info", "deployed");

            // Broadcast cache purge event to CDN Edge Routers via Redis Pub/Sub
            await redisClient.publish("cache-purge", JSON.stringify({ id }));
            console.log(`[Deploy Service] Published cache-purge event for deployment ID ${id}`);

            console.log(`[Deploy Service] Deployment ${id} successfully completed and deployed!`);
        } catch (err: any) {
            console.error(`[Deploy Service] Failed to process deployment ${id}:`, err);
            await redisClient.hset("status", id, "failed");
            await publishBuildLog(id, `Deployment failed: ${err.message || err}`, "stderr", "failed");
            throw err;
        }
    },
    {
        connection: redisConnection,
        concurrency: 2, // Process up to 2 builds concurrently
    }
);

worker.on("completed", (job) => {
    console.log(`[Deploy Service] Job ${job.id} has completed successfully.`);
});

worker.on("failed", (job, err) => {
    console.error(`[Deploy Service] Job ${job?.id} failed with error:`, err);
});
