import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { downloadS3Folder, copyFinalDist } from "./aws";
import { buildProject } from "./utils";
import { config } from "./config";

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
    async (job: Job<{ id: string }>) => {
        const id = job.data.id;
        console.log(`[Deploy Service] Processing build job ${job.id} for deployment ID ${id}...`);

        try {
            await redisClient.hset("status", id, "building");
            console.log(`[Deploy Service] Downloading S3 source files for ${id}...`);
            await downloadS3Folder(`output/${id}`);

            console.log(`[Deploy Service] Building project for ${id}...`);
            await buildProject(id);

            console.log(`[Deploy Service] Uploading compiled dist files for ${id}...`);
            await copyFinalDist(id);

            await redisClient.hset("status", id, "deployed");

            // Broadcast cache purge event to CDN Edge Routers via Redis Pub/Sub
            await redisClient.publish("cache-purge", JSON.stringify({ id }));
            console.log(`[Deploy Service] Published cache-purge event for deployment ID ${id}`);

            console.log(`[Deploy Service] Deployment ${id} successfully completed and deployed!`);
        } catch (err: any) {
            console.error(`[Deploy Service] Failed to process deployment ${id}:`, err);
            await redisClient.hset("status", id, "failed");
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
