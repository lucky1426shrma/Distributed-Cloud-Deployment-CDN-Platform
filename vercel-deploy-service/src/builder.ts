import { exec, spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import Redis from "ioredis";
import { config } from "./config";

export interface BuildOptions {
    id: string;
    deploymentType?: string;
    rootDirectory?: string;
    memoryLimitMb?: number;
    cpuLimit?: number;
    timeoutMs?: number;
    buildScript?: string;
}

const redisConnection = {
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
};

const redisPublisher = new Redis(redisConnection);

export async function publishBuildLog(
    id: string, 
    logMessage: string, 
    type: "stdout" | "stderr" | "info" = "stdout",
    status?: string
): Promise<void> {
    const payload = JSON.stringify({
        log: logMessage,
        type,
        status,
        timestamp: new Date().toISOString()
    });

    try {
        await redisPublisher.publish(`build-logs:${id}`, payload);
        await redisPublisher.rpush(`build-logs-history:${id}`, payload);
        await redisPublisher.expire(`build-logs-history:${id}`, 86400); // 24hr TTL
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

    // If no package.json exists in target directory, skip npm install and normalize directly
    const hasPackageJson = fs.existsSync(path.join(projectDir, "package.json"));
    if (!hasPackageJson) {
        console.log(`[Sandboxed Builder] No package.json found in ${projectDir}. Skipping build and normalizing outputs...`);
        await publishBuildLog(id, `No package.json found. Applying preset '${deploymentType.toUpperCase()}'...`, "info");
        normalizeBuildOutputDir(projectDir, deploymentType);
        return;
    }

    // Check if Docker is available in the environment
    const isDockerAvailable = await new Promise<boolean>((resolve) => {
        exec("docker --version", (err) => {
            resolve(!err);
        });
    });

    if (isDockerAvailable) {
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
    } else {
        // Native Node.js / NPM build fallback (for PaaS cloud environments without Docker daemon like Render)
        console.log(`[Sandboxed Builder] Docker not detected. Executing native cloud build in ${projectDir}...`);
        await publishBuildLog(id, `Executing native cloud build with Node.js 20...`, "info", "building");

        return new Promise((resolve, reject) => {
            const shellCmd = process.platform === "win32" ? "npm.cmd" : "npm";
            const installChild = exec(`npm install --omit=dev && npm run build --if-present`, { cwd: projectDir }, (err, stdout, stderr) => {
                if (err) {
                    const errorMsg = stderr || err.message;
                    console.error(`[Native Builder] Native build failed for ${id}:`, errorMsg);
                    publishBuildLog(id, `Build failed: ${errorMsg}`, "stderr", "failed");
                    return reject(new Error(`Native build execution failed for ${id}: ${errorMsg}`));
                }

                console.log(`[Native Builder] Native build for ${id} completed successfully.`);
                publishBuildLog(id, `Build step finished. Normalizing assets for preset '${deploymentType.toUpperCase()}'...`, "info");
                
                try {
                    normalizeBuildOutputDir(projectDir, deploymentType);
                    resolve();
                } catch (normErr: any) {
                    reject(normErr);
                }
            });

            installChild.stdout?.on("data", (data) => {
                const line = data.toString().trim();
                if (line) publishBuildLog(id, line, "stdout");
            });

            installChild.stderr?.on("data", (data) => {
                const line = data.toString().trim();
                if (line) publishBuildLog(id, line, "stderr");
            });
        });
    }
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

    // 1. If explicit package.json has a "main" file, ensure it is packaged into functions/index.js
    const pkgJsonPath = path.join(projectDir, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
            if (pkg.main && typeof pkg.main === "string") {
                const mainFilePath = path.join(projectDir, pkg.main);
                if (fs.existsSync(mainFilePath)) {
                    console.log(`[Sandboxed Builder] package.json main entry point found: '${pkg.main}'`);
                    if (!fs.existsSync(functionsPath)) fs.mkdirSync(functionsPath, { recursive: true });
                    fs.copyFileSync(mainFilePath, path.join(functionsPath, "index.js"));
                    fs.copyFileSync(mainFilePath, path.join(functionsPath, path.basename(pkg.main)));
                }
            }
        } catch {}
    }

    // 2. Monorepo / Subfolder backend resolution
    const possibleBackendDirs = ["backend", "api", "server", "functions", "src"];
    for (const sub of possibleBackendDirs) {
        const subDir = path.join(projectDir, sub);
        if (fs.existsSync(subDir) && fs.statSync(subDir).isDirectory()) {
            const subFiles = fs.readdirSync(subDir);
            for (const f of subFiles) {
                if (f.endsWith(".js") || f.endsWith(".ts")) {
                    const fPath = path.join(subDir, f);
                    if (deploymentType === "express" || isBackendServerFile(fPath)) {
                        console.log(`[Sandboxed Builder] Subfolder backend file identified: '${sub}/${f}'`);
                        if (!fs.existsSync(functionsPath)) fs.mkdirSync(functionsPath, { recursive: true });
                        fs.copyFileSync(fPath, path.join(functionsPath, "index.js"));
                        fs.copyFileSync(fPath, path.join(functionsPath, f));
                    }
                }
            }
        }
    }

    // 3. Scan root directory for backend server files
    const rootFiles = fs.readdirSync(projectDir);
    const ignoreFiles = ["dist", "build", "out", "node_modules", "functions", "api", "backend", ".git", ".cache"];

    for (const file of rootFiles) {
        if (ignoreFiles.includes(file)) continue;
        const filePath = path.join(projectDir, file);

        if (file.endsWith(".js") || file.endsWith(".ts")) {
            if (deploymentType === "express" || isBackendServerFile(filePath)) {
                console.log(`[Sandboxed Builder] Backend entry point identified: '${file}'`);
                if (!fs.existsSync(functionsPath)) fs.mkdirSync(functionsPath, { recursive: true });
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

    // Static site fallback
    if (rootFiles.includes("index.html") || rootFiles.some(f => f.endsWith(".html")) || deploymentType === "static") {
        console.log(`[Sandboxed Builder] Static HTML project detected. Copying root files to dist/...`);
        copyDirRecursive(projectDir, distPath, ["dist", "functions", "backend", "api", "node_modules", ".git", ".cache"]);
        return;
    }

    // Pure Backend App Fallback: Generate static fallback index.html inside dist/
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
        .badge { display: inline-block; background: #064e3b; color: #34d399; padding: 4px 12px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; margin-bottom: 1rem; }
        code { background: #1f2937; color: #60a5fa; padding: 2px 6px; border-radius: 4px; font-size: 0.85rem; }
    </style>
</head>
<body>
    <div class="card">
        <div class="badge">API READY</div>
        <h1>Serverless API Endpoint</h1>
        <p>This deployment is configured as a standalone serverless backend. You can access your API routes directly via <code>/api</code> or your configured endpoints.</p>
    </div>
</body>
</html>`;
        fs.writeFileSync(path.join(distPath, "index.html"), htmlContent);
        return;
    }

    // Default fallback: copy project directory ignoring node_modules & build folders
    console.log(`[Sandboxed Builder] Fallback: Copying project files to dist/...`);
    copyDirRecursive(projectDir, distPath, ["dist", "functions", "backend", "api", "node_modules", ".git", ".cache"]);
}

function copyDirRecursive(src: string, dest: string, ignoreNames: string[] = []): void {
    if (!fs.existsSync(src)) return;
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        if (ignoreNames.includes(entry.name)) continue;

        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath, ignoreNames);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}
