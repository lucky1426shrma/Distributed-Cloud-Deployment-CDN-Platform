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
    deploymentType?: string;
    rootDirectory?: string;
    memoryLimitMb?: number; // default 512MB
    cpuLimit?: number;      // default 1.0 core
    timeoutMs?: number;     // default 5 minutes
    buildScript?: string;
}

export async function publishBuildLog(
    id: string, 
    log: string, 
    type: "stdout" | "stderr" | "info" = "stdout",
    status?: "uploaded" | "building" | "deployed" | "failed"
) {
    try {
        const payload = JSON.stringify({
            id,
            log,
            type,
            status,
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
        deploymentType = "auto",
        rootDirectory = "",
        memoryLimitMb = 512,
        cpuLimit = 1.0,
        timeoutMs = 5 * 60 * 1000,
        buildScript = "npm install --if-present && npm run build --if-present"
    } = options;

    const baseDir = path.resolve(__dirname, `output/${id}`);
    const projectDir = rootDirectory ? path.join(baseDir, rootDirectory) : baseDir;

    if (!fs.existsSync(projectDir)) {
        throw new Error(`Project directory does not exist: ${projectDir}`);
    }

    // If no package.json exists in target directory, skip npm install in Docker and normalize directly
    const hasPackageJson = fs.existsSync(path.join(projectDir, "package.json"));
    if (!hasPackageJson) {
        console.log(`[Sandboxed Builder] No package.json found in ${projectDir}. Skipping container build and normalizing outputs...`);
        await publishBuildLog(id, `No package.json found in root. Applying preset '${deploymentType.toUpperCase()}'...`, "info");
        normalizeBuildOutputDir(projectDir, deploymentType);
        return;
    }

    let dockerVolumePath = baseDir;
    if (process.platform === "win32") {
        dockerVolumePath = baseDir.replace(/\\/g, "/");
    }

    const workDir = rootDirectory ? `/app/${rootDirectory.replace(/\\/g, "/")}` : "/app";
    const containerName = `vercel-builder-${id}`;
    const dockerCmd = `docker run --name ${containerName} --rm --memory=${memoryLimitMb}m --cpus=${cpuLimit} -v "${dockerVolumePath}:/app" -w "${workDir}" node:20-alpine sh -c "${buildScript}"`;

    console.log(`[Sandboxed Builder] Launching isolated Docker build container for ${id} (Preset: ${deploymentType.toUpperCase()}, WorkDir: ${workDir})...`);
    await publishBuildLog(id, `Launching Docker container for preset '${deploymentType.toUpperCase()}' (${memoryLimitMb}MB RAM, ${cpuLimit} CPU)...`, "info", "building");

    return new Promise((resolve, reject) => {
        let child: ChildProcess;
        let isTimedOut = false;

        const timer = setTimeout(() => {
            isTimedOut = true;
            console.error(`[Sandboxed Builder] Build timeout of ${timeoutMs}ms exceeded for deployment ${id}. Killing container...`);
            publishBuildLog(id, `Build timeout of ${timeoutMs / 1000}s exceeded. Container killed.`, "stderr", "failed");
            exec(`docker kill ${containerName}`, () => {
                reject(new Error(`Build timed out after ${timeoutMs / 1000} seconds.`));
            });
        }, timeoutMs);

        try {
            child = exec(dockerCmd, (error, stdout, stderr) => {
                clearTimeout(timer);

                if (isTimedOut) return;

                if (error) {
                    const errorMsg = stderr || error.message;
                    console.error(`[Sandboxed Builder] Docker container build failed for ${id}:`, errorMsg);
                    publishBuildLog(id, `Build failed: ${errorMsg}`, "stderr", "failed");
                    return reject(new Error(`Docker container execution failed for ${id}: ${errorMsg}`));
                }

                console.log(`[Sandboxed Builder] Build container for ${id} completed successfully.`);
                publishBuildLog(id, `Build step finished. Normalizing assets for preset '${deploymentType.toUpperCase()}'...`, "info");
                
                try {
                    normalizeBuildOutputDir(projectDir, deploymentType);
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

function isBackendServerFile(filePath: string): boolean {
    try {
        if (!filePath.endsWith(".js") && !filePath.endsWith(".ts")) return false;
        const content = fs.readFileSync(filePath, "utf-8");
        const isServerKeywords = /express|createServer|http\.createServer|app\.listen|module\.exports\s*=|exports\.default|exports\.handler/i.test(content);
        const isClientDOM = /document\.getElementById|ReactDOM|window\.location|react-dom/i.test(content);
        return isServerKeywords && !isClientDOM;
    } catch {
        return false;
    }
}

function normalizeBuildOutputDir(projectDir: string, deploymentType: string = "auto"): void {
    const distPath = path.join(projectDir, "dist");
    const buildPath = path.join(projectDir, "build");
    const outPath = path.join(projectDir, "out");
    const functionsPath = path.join(projectDir, "functions");

    // 1. Explicit Preset OR api/ directory: Package serverless backend functions
    const apiPath = path.join(projectDir, "api");
    if (fs.existsSync(apiPath)) {
        console.log(`[Sandboxed Builder] Dedicated API directory detected: api/. Packaging functions...`);
        if (!fs.existsSync(functionsPath)) fs.mkdirSync(functionsPath, { recursive: true });
        copyDirRecursive(apiPath, functionsPath);
    }

    // 2. Scan backend/ subfolder if present
    const backendSubDir = path.join(projectDir, "backend");
    if (fs.existsSync(backendSubDir)) {
        console.log(`[Sandboxed Builder] Backend subfolder detected: backend/. Packaging backend functions...`);
        const backendFiles = fs.readdirSync(backendSubDir);
        for (const f of backendFiles) {
            const fPath = path.join(backendSubDir, f);
            if (f.endsWith(".js") || f.endsWith(".ts")) {
                if (deploymentType === "express" || isBackendServerFile(fPath)) {
                    if (!fs.existsSync(functionsPath)) fs.mkdirSync(functionsPath, { recursive: true });
                    // ALWAYS write index.js as the primary function bundle
                    fs.copyFileSync(fPath, path.join(functionsPath, "index.js"));
                    fs.copyFileSync(fPath, path.join(functionsPath, f));
                    console.log(`[Sandboxed Builder] Packaged backend file '${f}' -> functions/index.js & functions/${f}`);
                }
            }
        }
    }

    // 3. Scan root JS/TS files
    const rootFiles = fs.readdirSync(projectDir);
    const ignoreFiles = ["dist", "build", "out", "node_modules", "functions", "api", "backend", ".git", ".cache"];

    for (const file of rootFiles) {
        if (ignoreFiles.includes(file)) continue;
        const filePath = path.join(projectDir, file);

        if (file.endsWith(".js") || file.endsWith(".ts")) {
            if (deploymentType === "express" || isBackendServerFile(filePath)) {
                console.log(`[Sandboxed Builder] Backend entry point identified: '${file}'`);
                if (!fs.existsSync(functionsPath)) fs.mkdirSync(functionsPath, { recursive: true });
                
                // ALWAYS write index.js as the primary function bundle
                fs.copyFileSync(filePath, path.join(functionsPath, "index.js"));
                fs.copyFileSync(filePath, path.join(functionsPath, file));
                console.log(`[Sandboxed Builder] Packaged '${file}' -> functions/index.js & functions/${file}`);
            }
        }
    }

    // 4. Output folder normalization
    if (fs.existsSync(distPath) && deploymentType !== "static") {
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

    // Static site fallback: If index.html or HTML files exist in root and user selected static/auto
    if (rootFiles.includes("index.html") || rootFiles.some(f => f.endsWith(".html")) || deploymentType === "static") {
        console.log(`[Sandboxed Builder] Static HTML project detected. Copying root files to dist/...`);
        copyDirRecursive(projectDir, distPath, ["dist", "functions", "backend", "api", "node_modules", ".git", ".cache"]);
        return;
    }

    // Pure Backend App Fallback: Generate static fallback index.html inside dist/ if serverless functions exist
    if ((fs.existsSync(functionsPath) && fs.readdirSync(functionsPath).length > 0) || deploymentType === "express") {
        console.log(`[Sandboxed Builder] Pure Express backend detected. Generating static index.html fallback...`);
        if (!fs.existsSync(distPath)) {
            fs.mkdirSync(distPath, { recursive: true });
        }
        const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Serverless API Deployment</title>
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #090d16; color: #f3f4f6; display: flex; height: 100vh; align-items: center; justify-content: center; margin: 0; }
        .card { background: #111827; border: 1px solid #1f2937; padding: 2rem; border-radius: 12px; max-width: 500px; text-align: center; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
        h1 { color: #10b981; font-size: 1.5rem; margin-bottom: 0.5rem; }
        p { color: #9ca3af; font-size: 0.95rem; line-height: 1.5; }
        code { background: #1f2937; padding: 0.2rem 0.4rem; border-radius: 4px; color: #60a5fa; font-family: monospace; }
    </style>
</head>
<body>
    <div class="card">
        <h1>🚀 Serverless API Active</h1>
        <p>Your Node.js / Express backend service is running live on the Edge CDN.</p>
        <p>Try making an API request to <code>/api/</code> or <code>/api/index</code></p>
    </div>
</body>
</html>`;
        fs.writeFileSync(path.join(distPath, "index.html"), htmlContent, "utf-8");
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
