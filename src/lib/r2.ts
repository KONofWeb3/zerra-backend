// src/lib/r2.ts
// Cloudflare R2 integration for temporary file storage before posting
// to Instagram. Files are deleted after the social platform fetches them
// to keep storage costs minimal.
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const R2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME ?? "zerra-uploads";

// Generate a presigned URL for direct-from-browser upload.
// The frontend uploads directly to R2 — no file bytes go through
// Render, keeping the backend fast and bandwidth costs zero.
export async function getUploadPresignedUrl(
  key: string,
  contentType: string,
  expiresInSeconds = 300 // 5 minutes — plenty of time for the upload
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    ContentType: contentType,
  });
  return getSignedUrl(R2, command, { expiresIn: expiresInSeconds });
}

// The public URL for a file after it's been uploaded.
// Requires the R2 bucket to have public access enabled (set via
// Cloudflare dashboard → R2 → bucket → Settings → Public access).
export function getPublicUrl(key: string): string {
  const publicDomain = process.env.R2_PUBLIC_DOMAIN!;
  // publicDomain is like: pub-xxxx.r2.dev or your custom domain
  return `https://${publicDomain}/${key}`;
}

// Delete a file from R2 after Instagram/TikTok has fetched it.
// Call this in the publish route after a successful post to keep
// storage usage near zero.
export async function deleteFile(key: string): Promise<void> {
  const command = new DeleteObjectCommand({ Bucket: BUCKET, Key: key });
  await R2.send(command);
}

// Generate a unique file key for uploads
export function generateFileKey(userId: string, filename: string): string {
  const ext       = filename.split(".").pop() ?? "bin";
  const timestamp = Date.now();
  const random    = Math.random().toString(36).slice(2, 8);
  return `uploads/${userId}/${timestamp}-${random}.${ext}`;
}