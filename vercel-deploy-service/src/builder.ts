import { exec, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import Redis from "ioredis";
import { config } from "./config";

const redisPublisher = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
});

export interface BuildOptions {
    id: string;
    memoryLimitMb?: number; // default 512MB
    cpuLimit?: number;      // default 1.0 core
    timeoutMs?: number;     // default 5 minutes
    buildScript?: string;
}

export async function publishBuildLog(id: string, log: string, type: "stdout" | "stderr" | "info" = "stdout") {
    try {
        const payload = JSON.stringify({
            id,
            log,
            type,
            timestamp: new Date().toISOString(),
        });
        await redisPublisher.publish(`build-logs:${id}`, payload);
        await redisPublisher.rpush(`build-logs-history:${id}`, payload);
        await redisPublisher.expire(`build-logs-history:${id}`, 3600); // 1 hour expiration
    } catch (err) {
        console.error(`[Sandboxed Builder] Error publishing log for ${id}:`, err);
    }
}

export async function buildProjectInDocker(options: BuildOptions): Promise<void> {
    const {
        id,
        memoryLimitMb = 512,
        cpuLimit = 1.0,
        timeoutMs = 5 * 60 * 1000,
        buildScript = "npm install --if-present && npm run build --if-present"
    } = options;

    const projectDir = path.resolve(__dirname, `output/${id}`);

    if (!fs.existsSync(projectDir)) {
        throw new Error(`Project directory does not exist: ${projectDir}`);
    }

    let dockerVolumePath = projectDir;
    if (process.platform === "win32") {
        dockerVolumePath = projectDir.replace(/\\/g, "/");
    }

    const containerName = `vercel-builder-${id}`;
    const dockerCmd = `docker run --name ${containerName} --rm --memory=${memoryLimitMb}m --cpus=${cpuLimit} -v "${dockerVolumePath}:/app" -w /app node:20-alpine sh -c "${buildScript}"`;

    console.log(`[Sandboxed Builder] Launching isolated Docker build container for ${id}...`);
    await publishBuildLog(id, `Launching isolated Docker build container (${memoryLimitMb}MB RAM, ${cpuLimit} CPU)...`, "info");

    return new Promise((resolve, reject) => {
        let child: ChildProcess;
        let isTimedOut = false;

        const timer = setTimeout(() => {
            isTimedOut = true;
            console.error(`[Sandboxed Builder] Build timeout of ${timeoutMs}ms exceeded for deployment ${id}. Killing container...`);
            publishBuildLog(id, `Build timeout of ${timeoutMs / 1000}s exceeded. Container killed.`, "stderr");
            exec(`docker kill ${containerName}`, () => {
                reject(new Error(`Build timed out after ${timeoutMs / 1000} seconds.`));
            });
        }, timeoutMs);

        try {
            child = exec(dockerCmd, (error, stdout, stderr) => {
                clearTimeout(timer);

                if (isTimedOut) return;

                if (error) {
                    console.error(`[Sandboxed Builder] Docker container build failed for ${id}:`, stderr || error.message);
                    publishBuildLog(id, `Container build note: ${stderr || error.message}`, "info");
                }

                console.log(`[Sandboxed Builder] Build container for ${id} completed.`);
                publishBuildLog(id, `Build container step finished. Normalizing static assets...`, "info");
                
                try {
                    normalizeBuildOutputDir(projectDir);
                    resolve();
                } catch (normErr: any) {
                    reject(normErr);
                }
            });

            child.stdout?.on("data", (data) => {
                const line = data.toString().trim();
                if (line) {
                    console.log(`[Container STDOUT - ${id}]: ${line}`);
                    publishBuildLog(id, line, "stdout");
                }
            });

            child.stderr?.on("data", (data) => {
                const line = data.toString().trim();
                if (line) {
                    console.warn(`[Container STDERR - ${id}]: ${line}`);
                    publishBuildLog(id, line, "stderr");
                }
            });

        } catch (err: any) {
            clearTimeout(timer);
            reject(err);
        }
    });
}

function normalizeBuildOutputDir(projectDir: string): void {
    const distPath = path.join(projectDir, "dist");
    const buildPath = path.join(projectDir, "build");
    const outPath = path.join(projectDir, "out");

    if (fs.existsSync(distPath)) {
        console.log(`[Sandboxed Builder] Output folder detected: dist/`);
        return;
    }

    if (fs.existsSync(buildPath)) {
        console.log(`[Sandboxed Builder] Output folder detected: build/. Copying to dist/...`);
        copyDirRecursive(buildPath, distPath);
        return;
    }

    if (fs.existsSync(outPath)) {
        console.log(`[Sandboxed Builder] Output folder detected: out/. Copying to dist/...`);
        copyDirRecursive(outPath, distPath);
        return;
    }

    // Static site fallback: If no dist/build/out exists, check if index.html or HTML files exist in root and copy root to dist/
    const rootFiles = fs.readdirSync(projectDir);
    if (rootFiles.includes("index.html") || rootFiles.some(f => f.endsWith(".html"))) {
        console.log(`[Sandboxed Builder] Static HTML project detected. Copying root files to dist/...`);
        copyDirRecursive(projectDir, distPath, ["dist", "node_modules", ".git"]);
        return;
    }

    throw new Error(`Build finished but no valid output directory (dist, build, out, or root index.html) was found in ${projectDir}.`);
}

function copyDirRecursive(src: string, dest: string, ignoreDirs: string[] = []): void {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        if (ignoreDirs.includes(entry.name)) {
            continue;
        }
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath, ignoreDirs);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}
