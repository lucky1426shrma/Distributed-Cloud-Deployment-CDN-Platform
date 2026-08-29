import { S3 } from "aws-sdk";
import fs from "fs";
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

export const uploadFile = async (fileName: string, localFilePath: string) => {
    // the localFilePath is just used to read the contents of the File from the machine
    // the directory on the obj store is made using the sliced name after output
    const fileContent = fs.readFileSync(localFilePath);
    const response = await s3.upload({
        Body: fileContent,
        Bucket: config.S3_BUCKET_NAME,
        Key: fileName,
    }).promise();
    console.log(`[Upload Service] Uploaded file ${fileName} to bucket ${config.S3_BUCKET_NAME}:`, response.Location || response.Key);
    return response;
};