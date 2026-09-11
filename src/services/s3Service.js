import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';

const s3 = new S3Client({
  region: env.AWS_REGION,
  ...(env.AWS_ACCESS_KEY_ID && {
    credentials: {
      accessKeyId:     env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  }),
});

export const uploadToS3 = async ({ buffer, key, contentType }) => {
  await s3.send(new PutObjectCommand({
    Bucket:      env.S3_BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: contentType,
  }));
  return `https://${env.S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
};

export const deleteFromS3 = async (key) => {
  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key })).catch(() => {});
};

// Extrae la key S3 de una URL pública
export const keyFromUrl = (url) => {
  if (!url) return null;
  try {
    return new URL(url).pathname.slice(1); // quita el '/' inicial
  } catch {
    return null;
  }
};
