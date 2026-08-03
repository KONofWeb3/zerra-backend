// src/routes/upload.ts
// Handles presigned URL generation for direct-to-R2 uploads.
// The actual file bytes never touch this server — the frontend
// uploads directly to R2 using the presigned URL, then calls
// the publish endpoint with the resulting public URL.

import { Router, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { AuthRequest } from "../types";
import { getUploadPresignedUrl, getPublicUrl, generateFileKey, deleteFile } from "../lib/r2";

const router = Router();

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg":      "jpg",
  "image/jpg":       "jpg",
  "image/png":       "png",
  "image/webp":      "webp",
  "video/mp4":       "mp4",
  "video/quicktime": "mov",
  "video/webm":      "webm",
};

const MAX_IMAGE_SIZE = 8  * 1024 * 1024;  // 8MB
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100MB

// POST /upload/presign — get a presigned URL to upload directly to R2
// Body: { filename: string, contentType: string, fileSize: number }
router.post("/presign", requireAuth, async (req, res: Response) => {
  const user = (req as AuthRequest).user;
  const { filename, contentType, fileSize } = req.body as {
    filename: string; contentType: string; fileSize: number;
  };

  if (!filename || !contentType || !fileSize) {
    res.status(400).json({ error: "filename, contentType and fileSize are required" });
    return;
  }

  if (!ALLOWED_TYPES[contentType]) {
    res.status(400).json({
      error: `File type not supported. Allowed: ${Object.keys(ALLOWED_TYPES).join(", ")}`,
    });
    return;
  }

  const isVideo = contentType.startsWith("video/");
  const maxSize = isVideo ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;
  if (fileSize > maxSize) {
    res.status(400).json({
      error: `File too large. Max size: ${isVideo ? "100MB for videos" : "8MB for images"}`,
    });
    return;
  }

  const key        = generateFileKey(user.id, filename);
  const uploadUrl  = await getUploadPresignedUrl(key, contentType);
  const publicUrl  = getPublicUrl(key);

  res.json({ uploadUrl, publicUrl, key });
});

// DELETE /upload/:key — delete a file from R2 (called after successful post)
router.delete("/*key", requireAuth, async (req, res: Response) => {
  const keyParam = req.params.key;
  const key = Array.isArray(keyParam) ? keyParam.join("/") : keyParam;

  // Security: ensure the key belongs to this user
  const user = (req as AuthRequest).user;
  if (!key.startsWith(`uploads/${user.id}/`)) {
    res.status(403).json({ error: "Not authorized to delete this file" });
    return;
  }

  try {
    await deleteFile(key);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;