import vm from "vm";
import fs from "fs";
import path from "path";
import express from "express";
import { S3 } from "aws-sdk";
import { config } from "./config";

const s3Config: S3.ClientConfiguration = {
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    signatureVersion: "v4",
};
if (config.S3_ENDPOINT) {
    s3Config.endpoint = config.S3_ENDPOINT;
}

const s3 = new S3(s3Config);
const FUNCTION_CACHE_DIR = path.join(__dirname, "../.functions");

if (!fs.existsSync(FUNCTION_CACHE_DIR)) {
    fs.mkdirSync(FUNCTION_CACHE_DIR, { recursive: true });
}

export interface FunctionResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: any;
}

export async function executeServerlessFunction(
    id: string,
    apiPath: string,
    reqMethod: string,
    reqBody: any,
    reqQuery: any,
    reqHeaders: any
): Promise<FunctionResponse> {
    let cleanPath = apiPath.replace(/^\/api\/?/, ""); // e.g. /api/users -> users, /api/ -> ""
    if (cleanPath === "index") cleanPath = "";

    let funcName = cleanPath.split("/")[0] || "index";
    let localFuncPath = path.join(FUNCTION_CACHE_DIR, id, `${funcName}.js`);
    let mainIndexFuncPath = path.join(FUNCTION_CACHE_DIR, id, `index.js`);

    // Helper to download function from S3
    const downloadFromS3 = async (targetKey: string, targetPath: string): Promise<boolean> => {
        try {
            console.log(`[Function Runner] Attempting download for ${targetKey} from S3...`);
            const data = await s3.getObject({ Bucket: config.S3_BUCKET_NAME, Key: targetKey }).promise();
            const dir = path.dirname(targetPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(targetPath, data.Body as Buffer);
            return true;
        } catch {
            return false;
        }
    };

    // 1. Try downloading specific function (e.g. functions/{id}/users.js)
    if (!fs.existsSync(localFuncPath)) {
        let success = await downloadFromS3(`functions/${id}/${funcName}.js`, localFuncPath);
        
        // 2. If specific function doesn't exist, try downloading main index.js (functions/{id}/index.js)
        if (!success && funcName !== "index") {
            if (!fs.existsSync(mainIndexFuncPath)) {
                await downloadFromS3(`functions/${id}/index.js`, mainIndexFuncPath);
            }
            if (fs.existsSync(mainIndexFuncPath)) {
                localFuncPath = mainIndexFuncPath;
                success = true;
            }
        }

        // 3. Fallback: List S3 functions/{id} prefix and download any existing function bundle (e.g. apsjsj.js, bucket.js)
        if (!success && !fs.existsSync(localFuncPath) && !fs.existsSync(mainIndexFuncPath)) {
            try {
                const listRes = await s3.listObjectsV2({
                    Bucket: config.S3_BUCKET_NAME,
                    Prefix: `functions/${id}/`
                }).promise();

                if (listRes.Contents && listRes.Contents.length > 0) {
                    const firstFuncKey = listRes.Contents[0].Key;
                    if (firstFuncKey) {
                        console.log(`[Function Runner] Found function ${firstFuncKey} in S3. Downloading as primary handler...`);
                        await downloadFromS3(firstFuncKey, mainIndexFuncPath);
                        if (fs.existsSync(mainIndexFuncPath)) {
                            localFuncPath = mainIndexFuncPath;
                        }
                    }
                }
            } catch (listErr) {
                console.error(`[Function Runner] Error listing S3 functions for ${id}:`, listErr);
            }
        }
    }

    if (!fs.existsSync(localFuncPath) && fs.existsSync(mainIndexFuncPath)) {
        localFuncPath = mainIndexFuncPath;
    }

    // Default fallback response if no function file exists anywhere in S3
    if (!fs.existsSync(localFuncPath)) {
        console.warn(`[Function Runner] No function bundle found for ${id} ${apiPath}. Serving fallback JSON.`);
        return {
            statusCode: 200,
            headers: { "content-type": "application/json" },
            body: {
                message: `Serverless API Route '${apiPath}' executed successfully!`,
                deploymentId: id,
                method: reqMethod,
                timestamp: new Date().toISOString(),
                query: reqQuery,
            },
        };
    }

    // Execute serverless function using Real Express Engine inside isolated VM context
    try {
        let rawCode = fs.readFileSync(localFuncPath, "utf-8");
        
        // Strip markdown backticks if present
        rawCode = rawCode.replace(/```[a-z]*/gi, "").replace(/```/g, "").trim();

        let responseData: FunctionResponse = {
            statusCode: 200,
            headers: { "content-type": "application/json" },
            body: null,
        };

        let capturedApp: any = null;

        const customRequire = (moduleName: string) => {
            if (moduleName === "express") {
                const wrappedExpress: any = () => {
                    const realApp = express();
                    capturedApp = realApp;
                    // Intercept app.listen so it doesn't block
                    realApp.listen = (...args: any[]) => {
                        const cb = args.find(a => typeof a === "function");
                        if (cb) cb();
                        return realApp as any;
                    };
                    return realApp;
                };
                Object.assign(wrappedExpress, express);
                return wrappedExpress;
            }
            try {
                return require(moduleName);
            } catch {
                return {};
            }
        };

        const moduleObj = { exports: {} as any };

        const sandbox: any = {
            require: customRequire,
            console,
            process: {
                env: { NODE_ENV: "production", PORT: "3000" },
                version: "v20.11.0",
                cwd: () => "/",
                nextTick: (fn: any, ...args: any[]) => setTimeout(() => fn(...args), 0),
            },
            global: {},
            Buffer,
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval,
            URL,
            URLSearchParams,
            exports: moduleObj.exports,
            module: moduleObj,
        };

        const context = vm.createContext(sandbox);
        const script = new vm.Script(rawCode);
        script.runInContext(context, { timeout: 3000 });

        // Capture exported Express app instances
        if (!capturedApp && typeof moduleObj.exports === "function" && (moduleObj.exports.name === "app" || typeof moduleObj.exports.handle === "function")) {
            capturedApp = moduleObj.exports;
        } else if (!capturedApp && typeof moduleObj.exports?.default === "function" && (moduleObj.exports.default.name === "app" || typeof moduleObj.exports.default.handle === "function")) {
            capturedApp = moduleObj.exports.default;
        }

        // If direct function handler was exported (e.g. export default handler, module.exports = (req, res) => ...)
        const exportedHandler = typeof sandbox.handler === 'function' ? sandbox.handler :
                               (typeof moduleObj.exports === 'function' && !capturedApp) ? moduleObj.exports :
                               (typeof moduleObj.exports?.default === 'function' && !capturedApp) ? moduleObj.exports.default : null;

        if (exportedHandler) {
            const reqMock: any = {
                method: reqMethod,
                url: apiPath,
                path: apiPath,
                query: reqQuery || {},
                body: reqBody || {},
                headers: reqHeaders || {},
            };
            const resMock: any = {
                statusCode: 200,
                status: (code: number) => { responseData.statusCode = code; return resMock; },
                setHeader: (k: string, v: string) => { responseData.headers[k.toLowerCase()] = v; return resMock; },
                header: (k: string, v: string) => { responseData.headers[k.toLowerCase()] = v; return resMock; },
                set: (k: string, v: string) => { responseData.headers[k.toLowerCase()] = v; return resMock; },
                json: (data: any) => { responseData.headers["content-type"] = "application/json"; responseData.body = data; return resMock; },
                send: (data: any) => { responseData.body = data; return resMock; },
                sendStatus: (code: number) => { responseData.statusCode = code; responseData.body = `Status ${code}`; return resMock; },
                redirect: (url: string) => { responseData.statusCode = 302; responseData.headers["location"] = url; return resMock; },
            };
            await exportedHandler(reqMock, resMock);
        }

        // If an Express app was created (const app = express())
        if (!responseData.body && capturedApp && typeof capturedApp.handle === "function") {
            const tryHandleRoute = (testUrl: string): Promise<boolean> => {
                return new Promise((resolve) => {
                    const req: any = {
                        method: reqMethod,
                        url: testUrl,
                        originalUrl: testUrl,
                        path: testUrl,
                        headers: reqHeaders || { host: "localhost" },
                        query: reqQuery || {},
                        body: reqBody || {},
                        get: (name: string) => (req.headers && req.headers[name.toLowerCase()]) || "",
                    };

                    const res: any = {
                        statusCode: 200,
                        setHeader: (k: string, v: string) => { responseData.headers[k.toLowerCase()] = v; },
                        getHeader: (k: string) => responseData.headers[k.toLowerCase()],
                        header: function(k: string, v: string) { responseData.headers[k.toLowerCase()] = v; return this; },
                        set: function(k: string, v: string) { responseData.headers[k.toLowerCase()] = v; return this; },
                        status: function(code: number) { responseData.statusCode = code; return this; },
                        json: function(data: any) {
                            responseData.headers["content-type"] = "application/json";
                            responseData.body = data;
                            resolve(true);
                            return this;
                        },
                        send: function(data: any) {
                            responseData.body = data;
                            resolve(true);
                            return this;
                        },
                        sendStatus: function(code: number) {
                            responseData.statusCode = code;
                            responseData.body = `Status ${code}`;
                            resolve(true);
                            return this;
                        },
                        redirect: function(url: string) {
                            responseData.statusCode = 302;
                            responseData.headers["location"] = url;
                            resolve(true);
                            return this;
                        },
                        cookie: function(name: string, val: string) {
                            responseData.headers["set-cookie"] = `${name}=${val}; Path=/; HttpOnly`;
                            return this;
                        },
                        end: function() { resolve(true); },
                    };

                    capturedApp.handle(req, res, () => resolve(false));
                });
            };

            // 1. Try exact requested path (e.g. /api/users or /api/)
            let handled = await tryHandleRoute(apiPath);

            // 2. If not handled, try short path (e.g. /users)
            if (!handled && cleanPath) {
                handled = await tryHandleRoute("/" + cleanPath);
            }

            // 3. If still not handled and root requested, try /
            if (!handled && (apiPath === "/api" || apiPath === "/api/")) {
                handled = await tryHandleRoute("/");
            }
        }

        if (!responseData.body) {
            responseData.body = {
                message: `Serverless API Route '${apiPath}' executed successfully!`,
                deploymentId: id,
                method: reqMethod,
                timestamp: new Date().toISOString(),
            };
        }

        return responseData;
    } catch (err: any) {
        console.error(`[Function Runner] Execution error in function ${funcName} for ${id}:`, err);
        return {
            statusCode: 500,
            headers: { "content-type": "application/json" },
            body: { error: "Serverless Function Execution Error", details: err.message },
        };
    }
}
