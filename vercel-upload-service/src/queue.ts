import { Queue } from "bullmq";
import { config } from "./config";

export const redisConnection = {
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
};

export const buildQueue = new Queue("build-queue", {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3, 
        // This means BullMQ can try the job up to 3 times if it fails.
        backoff: {
            type: "exponential",
            delay: 1000,
        },
        removeOnComplete: true,
        removeOnFail: false,
    },
});

console.log("[Upload Service] BullMQ build-queue initialized.");
