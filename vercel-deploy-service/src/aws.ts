import { S3 } from "aws-sdk";
import fs from "fs";
import path from "path";
import { config } from "./config";

const s3Config: S3.ClientConfiguration = {
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    signatureVersion: "v4",
};

if (config.S3_ENDPOINT) {
    s3Config.endpoint = config.S3_ENDPOINT;
}

export const s3 = new S3(s3Config);

export async function downloadS3Folder(prefix: string) {
    const allFiles = await s3.listObjectsV2({
        Bucket: config.S3_BUCKET_NAME,
        Prefix: prefix
    }).promise();
    
    const allPromises = allFiles.Contents?.map(async ({ Key }) => {
        return new Promise<void>(async (resolve, reject) => {
            if (!Key) {
                resolve();
                return;
            }
            const finalOutputPath = path.join(__dirname, Key);
            const outputFile = fs.createWriteStream(finalOutputPath);
            const dirName = path.dirname(finalOutputPath);
            if (!fs.existsSync(dirName)){
                fs.mkdirSync(dirName, { recursive: true });
            }
            s3.getObject({
                Bucket: config.S3_BUCKET_NAME,
                Key
            })
            .createReadStream()
            .pipe(outputFile)
            .on("finish", () => resolve())
            .on("error", (err) => reject(err));
        });
    }) || [];

    await Promise.all(allPromises);
    console.log(`[Deploy Service] Successfully downloaded all files for prefix ${prefix}`);
}

// Upload compiled dist static files AND functions to S3 bucket
export async function copyFinalDist(id: string, rootDirectory: string = "") {
    const baseDir = path.join(__dirname, `output/${id}`);
    const projectDir = rootDirectory ? path.join(baseDir, rootDirectory) : baseDir;

    // 1. Upload dist static assets from projectDir or baseDir
    let folderPath = path.join(projectDir, "dist");
    if (!fs.existsSync(folderPath) && fs.existsSync(path.join(baseDir, "dist"))) {
        folderPath = path.join(baseDir, "dist");
    }
    if (fs.existsSync(folderPath)) {
        const allFiles = getAllFiles(folderPath);
        for (const file of allFiles) {
            const destinationKey = `dist/${id}/` + file.slice(folderPath.length + 1).replace(/\\/g, "/");
            await uploadFile(destinationKey, file);
        }
    }

    // 2. Upload functions serverless API bundles from projectDir or baseDir
    let functionsFolderPath = path.join(projectDir, "functions");
    if (!fs.existsSync(functionsFolderPath) && fs.existsSync(path.join(baseDir, "functions"))) {
        functionsFolderPath = path.join(baseDir, "functions");
    }
    if (fs.existsSync(functionsFolderPath)) {
        const funcFiles = getAllFiles(functionsFolderPath);
        for (const file of funcFiles) {
            const destinationKey = `functions/${id}/` + file.slice(functionsFolderPath.length + 1).replace(/\\/g, "/");
            await uploadFile(destinationKey, file);
            console.log(`[Deploy Service] Uploaded serverless function bundle: ${destinationKey}`);
        }
    }
}

const getAllFiles = (folderPath: string) => {
    let response: string[] = [];
    const allFilesAndFolders = fs.readdirSync(folderPath);
    allFilesAndFolders.forEach(file => {
        const fullFilePath = path.join(folderPath, file);
        if (fs.statSync(fullFilePath).isDirectory()) {
            response = response.concat(getAllFiles(fullFilePath));
        } else {
            response.push(fullFilePath);
        }
    });
    return response;
};

const uploadFile = async (fileName: string, localFilePath: string) => {
    const fileContent = fs.readFileSync(localFilePath);
    await s3.upload({
        Body: fileContent,
        Bucket: config.S3_BUCKET_NAME,
        Key: fileName,
    }).promise();
    console.log(`[Deploy Service] Uploaded asset ${fileName}`);
};