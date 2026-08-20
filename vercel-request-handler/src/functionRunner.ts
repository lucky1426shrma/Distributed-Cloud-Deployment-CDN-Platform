import vm from "vm";
import fs from "fs";
import path from "path";
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
    const cleanPath = apiPath.replace(/^\/api\/?/, ""); // e.g. /api/hello -> hello
    const funcName = cleanPath || "index";
    const localFuncPath = path.join(FUNCTION_CACHE_DIR, id, `${funcName}.js`);

    // Download function bundle from S3 if not cached locally
    if (!fs.existsSync(localFuncPath)) {
        try {
            const key = `functions/${id}/${funcName}.js`;
            console.log(`[Function Runner] Downloading serverless function ${key} from S3...`);
            const data = await s3.getObject({ Bucket: config.S3_BUCKET_NAME, Key: key }).promise();
            
            const dir = path.dirname(localFuncPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            
            fs.writeFileSync(localFuncPath, data.Body as Buffer);
        } catch (err: any) {
            console.warn(`[Function Runner] Function ${funcName} not found for ${id}. Creating default API fallback handler.`);
            // Create default API response if no custom function bundle uploaded
            return {
                statusCode: 200,
                headers: { "content-type": "application/json" },
                body: {
                    message: `Serverless API Route '/api/${funcName}' executed successfully!`,
                    deploymentId: id,
                    method: reqMethod,
                    timestamp: new Date().toISOString(),
                    query: reqQuery,
                },
            };
        }
    }

    // Execute serverless function in isolated VM context
    try {
        const code = fs.readFileSync(localFuncPath, "utf-8");
        
        let responseData: FunctionResponse = {
            statusCode: 200,
            headers: { "content-type": "application/json" },
            body: null,
        };

        const sandbox = {
            console,
            Buffer,
            setTimeout,
            clearTimeout,
            request: {
                method: reqMethod,
                body: reqBody,
                query: reqQuery,
                headers: reqHeaders,
            },
            response: {
                status: (code: number) => {
                    responseData.statusCode = code;
                    return sandbox.response;
                },
                setHeader: (name: string, value: string) => {
                    responseData.headers[name.toLowerCase()] = value;
                    return sandbox.response;
                },
                json: (data: any) => {
                    responseData.headers["content-type"] = "application/json";
                    responseData.body = data;
                    return sandbox.response;
                },
                send: (data: any) => {
                    responseData.body = data;
                    return sandbox.response;
                },
            },
        };

        const context = vm.createContext(sandbox);
        const script = new vm.Script(`
            (async () => {
                ${code}
                if (typeof handler === 'function') {
                    await handler(request, response);
                } else if (typeof exports.default === 'function') {
                    await exports.default(request, response);
                } else if (typeof module !== 'undefined' && module.exports) {
                    const fn = typeof module.exports === 'function' ? module.exports : module.exports.default;
                    if (fn) await fn(request, response);
                }
            })();
        `);

        await script.runInContext(context, { timeout: 3000 }); // 3 sec function execution timeout
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
