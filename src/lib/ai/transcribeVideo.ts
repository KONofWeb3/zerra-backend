// src/lib/ai/transcribeVideo.ts
import { createClient } from "@deepgram/sdk";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import https from "https";

const deepgram = createClient(process.env.DEEPGRAM_API_KEY!);

/**
 * Resolves a TikTok embed_link / public video URL into a direct, downloadable
 * MP4 URL via ScrapTik (RapidAPI). Required because TikTok's official API
 * (video.list scope) does not return a raw video_url field.
 */
async function resolveDirectVideoUrl(tiktokUrl: string): Promise<string> {
  const res = await fetch(
    `https://scraptik.p.rapidapi.com/video/data?url=${encodeURIComponent(tiktokUrl)}`,
    {
      headers: {
        "X-RapidAPI-Key": process.env.RAPIDAPI_KEY!,
        "X-RapidAPI-Host": "scraptik.p.rapidapi.com",
      },
    }
  );

  if (!res.ok) {
    throw new Error(`ScrapTik resolve failed: ${res.status}`);
  }

  const data = await res.json();
  // Exact response shape depends on ScrapTik's endpoint — adjust field path
  // after checking their docs. Common shape: data.video.play_addr.url_list[0]
  const directUrl =
    data?.video?.play_addr?.url_list?.[0] ||
    data?.data?.play ||
    data?.play;

  if (!directUrl) {
    throw new Error("Could not resolve direct video URL from ScrapTik response");
  }

  return directUrl;
}

function downloadVideo(videoUrl: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    https
      .get(videoUrl, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Video download failed: HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", reject);
  });
}

function extractAudio(videoPath: string, audioPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .output(audioPath)
      .audioCodec("pcm_s16le")
      .on("end", () => resolve())
      .on("error", reject)
      .run();
  });
}

/**
 * Full pipeline: resolve TikTok URL -> download video -> extract audio -> Deepgram transcribe.
 * Always cleans up temp files, even on failure.
 */
export async function transcribeVideo(
  tiktokEmbedUrl: string,
  videoId: string
): Promise<string> {
  const videoPath = `/tmp/video_${videoId}.mp4`;
  const audioPath = `/tmp/audio_${videoId}.wav`;

  try {
    const directUrl = await resolveDirectVideoUrl(tiktokEmbedUrl);
    await downloadVideo(directUrl, videoPath);
    await extractAudio(videoPath, audioPath);

    const audioBuffer = fs.readFileSync(audioPath);
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      audioBuffer,
      { model: "nova-2", smart_format: true }
    );

    if (error) {
      throw new Error(`Deepgram error: ${error.message}`);
    }

    const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
    return transcript;
  } finally {
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  }
}