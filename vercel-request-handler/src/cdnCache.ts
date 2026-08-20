import crypto from "crypto";
import fs from "fs";
import path from "path";
import { LRUCache } from "lru-cache";

export interface CacheEntry {
    body: Buffer;
    contentType: string;
    etag: string;
    size: number;
}

// L1 In-Memory LRU Cache: Max 50MB
const MAX_L1_SIZE = 50 * 1024 * 1024; // 50MB

const l1Cache = new LRUCache<string, CacheEntry>({
    maxSize: MAX_L1_SIZE,
    sizeCalculation: (entry) => entry.size,
    ttl: 1000 * 60 * 60 * 24, // 24 hours
});

const L2_CACHE_DIR = path.join(__dirname, "../.cache");

if (!fs.existsSync(L2_CACHE_DIR)) {
    fs.mkdirSync(L2_CACHE_DIR, { recursive: true });
}

export function computeETag(body: Buffer): string {
    const hash = crypto.createHash("md5").update(body).digest("hex");
    return `"${hash}"`;
}

// Get asset from L1 (Memory)
export function getL1(key: string): CacheEntry | undefined {
    return l1Cache.get(key);
}

// Set asset in L1 (Memory)
export function setL1(key: string, entry: CacheEntry): void {
    l1Cache.set(key, entry);
}

// Get asset from L2 (Disk)
export function getL2(key: string): CacheEntry | null {
    try {
        const filePath = path.join(L2_CACHE_DIR, key);
        const metaPath = `${filePath}.meta.json`;

        if (fs.existsSync(filePath) && fs.existsSync(metaPath)) {
            const body = fs.readFileSync(filePath);
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
            const entry: CacheEntry = {
                body,
                contentType: meta.contentType,
                etag: meta.etag,
                size: body.length,
            };
            // Populate L1 cache on L2 hit
            setL1(key, entry);
            return entry;
        }
    } catch (err) {
        console.error(`[CDN L2 Cache] Error reading L2 cache for ${key}:`, err);
    }
    return null;
}

// Set asset in L2 (Disk)
export function setL2(key: string, entry: CacheEntry): void {
    try {
        const filePath = path.join(L2_CACHE_DIR, key);
        const dirName = path.dirname(filePath);

        if (!fs.existsSync(dirName)) {
            fs.mkdirSync(dirName, { recursive: true });
        }

        fs.writeFileSync(filePath, entry.body);
        fs.writeFileSync(`${filePath}.meta.json`, JSON.stringify({
            contentType: entry.contentType,
            etag: entry.etag,
            size: entry.size,
            cachedAt: new Date().toISOString(),
        }));
    } catch (err) {
        console.error(`[CDN L2 Cache] Error writing L2 cache for ${key}:`, err);
    }
}

// Purge cache (L1 + L2) for a given deployment ID
export function purgeDeploymentCache(deploymentId: string): void {
    console.log(`[CDN Cache Purge] Purging cache for deployment ID ${deploymentId}...`);
    
    // Purge L1 Memory Cache
    const keysToPurge: string[] = [];
    for (const key of l1Cache.keys()) {
        if (key.startsWith(`dist/${deploymentId}`)) {
            keysToPurge.push(key);
        }
    }
    keysToPurge.forEach((key) => l1Cache.delete(key));

    // Purge L2 Disk Cache
    const l2TargetFolder = path.join(L2_CACHE_DIR, `dist/${deploymentId}`);
    if (fs.existsSync(l2TargetFolder)) {
        try {
            fs.rmSync(l2TargetFolder, { recursive: true, force: true });
            console.log(`[CDN Cache Purge] Successfully removed L2 disk cache directory ${l2TargetFolder}`);
        } catch (err) {
            console.error(`[CDN Cache Purge] Error removing L2 directory ${l2TargetFolder}:`, err);
        }
    }
}
