import { execFile } from "child_process";
import { app } from "electron"; // tslint:disable-line:no-implicit-dependencies
import fs, { promises as fsp } from "fs";
import os from "os";
import path from "path";
import process from "process";
import { promisify } from "util";

import fetch from "node-fetch";

const execFileAsync = promisify(execFile);

// External runtime binaries are downloaded lazily on the user's machine and
// cached here so they are fetched once and reused across launches, instead of
// being bundled into every build. The archive extractor is the only piece that
// ships with the app (see extraResources), because we need it to unpack these
// downloads at runtime.
const isDev = process.env.NODE_ENV === "development";

const extractorDir = isDev
  ? path.join(app.getAppPath(), "..", "..", "..", "extraResources")
  : path.join(process.resourcesPath, "extraResources");

const extractorPath = path.join(
  extractorDir,
  process.platform === "win32" ? "7za.exe" : "7za",
);

const cacheDir = path.join(app.getPath("userData"), "externalResources");

export interface ResourcePaths {
  // Path to the ffmpeg executable
  ffmpeg: string;
  // Path to the ytdlp executable
  ytdlp: string;
}

const linuxResourcePaths: ResourcePaths = {
  ffmpeg: path.join(cacheDir, "ffmpeg", "ffmpeg"),
  ytdlp: path.join(cacheDir, "ytdlp", "yt-dlp"),
};

const macosResourcePaths: ResourcePaths = {
  ffmpeg: path.join(cacheDir, "ffmpeg", "ffmpeg"),
  ytdlp: path.join(cacheDir, "ytdlp", "yt-dlp_macos"),
};

const winResourcePaths: ResourcePaths = {
  ffmpeg: path.join(cacheDir, "ffmpeg", "ffmpeg.exe"),
  ytdlp: path.join(cacheDir, "ytdlp", "yt-dlp.exe"),
};

const resourcePaths: ResourcePaths =
  process.platform === "win32"
    ? winResourcePaths
    : process.platform === "darwin"
      ? macosResourcePaths
      : linuxResourcePaths;

export function getResourcePaths(): ResourcePaths {
  return resourcePaths;
}

async function fetchWithRetries(url: string, retries: number) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff between attempts. Some hosts (e.g. CDNs that
      // rate-limit certain IPs) reset the connection instead of returning an
      // HTTP error, so we must retry on thrown network errors too, not just on
      // non-ok responses.
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
    try {
      const res = await fetch(url);
      if (res.ok) {
        return res;
      }
      lastError = new Error(String(res.status));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetchWithRetries(url, 5);
  const fileStream = fs.createWriteStream(dest);
  await new Promise<void>((resolve, reject) => {
    res.body!.pipe(fileStream);
    res.body!.on("error", reject);
    fileStream.on("finish", () => resolve());
  });
}

// Copy an extracted binary into its final cached location atomically: write to
// a sibling temp file (same directory, so the rename stays on one filesystem)
// and rename into place last. An interrupted download therefore never leaves a
// file that looks complete.
async function finalize(src: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.part`;
  await fsp.copyFile(src, partial);
  await fsp.rename(partial, dest);
}

async function extract(archive: string, outDir: string): Promise<void> {
  await execFileAsync(extractorPath, ["e", archive, "-y", `-o${outDir}`]);
}

async function installWin(tmpDir: string): Promise<void> {
  const archive = path.join(tmpDir, "ffmpeg.7z");
  const ffmpegOut = path.join(tmpDir, "ffmpeg-out");
  await Promise.all([
    downloadFile(
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
      path.join(tmpDir, "yt-dlp.exe"),
    ),
    downloadFile(
      "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z",
      archive,
    ),
  ]);
  await extract(archive, ffmpegOut);
  await finalize(path.join(tmpDir, "yt-dlp.exe"), winResourcePaths.ytdlp);
  await finalize(path.join(ffmpegOut, "ffmpeg.exe"), winResourcePaths.ffmpeg);
}

async function installMacos(tmpDir: string): Promise<void> {
  const archive = path.join(tmpDir, "ffmpeg.zip");
  const ffmpegOut = path.join(tmpDir, "ffmpeg-out");
  await Promise.all([
    downloadFile(
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
      path.join(tmpDir, "yt-dlp_macos"),
    ),
    downloadFile("https://evermeet.cx/ffmpeg/ffmpeg-6.1.1.zip", archive),
  ]);
  await extract(archive, ffmpegOut);
  await finalize(path.join(tmpDir, "yt-dlp_macos"), macosResourcePaths.ytdlp);
  await finalize(path.join(ffmpegOut, "ffmpeg"), macosResourcePaths.ffmpeg);
}

async function installLinux(tmpDir: string): Promise<void> {
  const archive = path.join(tmpDir, "ffmpeg.tar.xz");
  const tarOut = path.join(tmpDir, "ffmpeg-tar");
  const ffmpegOut = path.join(tmpDir, "ffmpeg-out");
  await Promise.all([
    downloadFile(
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp",
      path.join(tmpDir, "yt-dlp"),
    ),
    downloadFile(
      // GitHub-hosted static build; johnvansickle.com resets connections from
      // some IPs. Flat extraction still yields the ffmpeg binary.
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
      archive,
    ),
  ]);
  // .tar.xz needs two passes: first to the .tar, then to the contents.
  await extract(archive, tarOut);
  await extract(path.join(tarOut, "ffmpeg.tar"), ffmpegOut);
  await finalize(path.join(tmpDir, "yt-dlp"), linuxResourcePaths.ytdlp);
  await finalize(path.join(ffmpegOut, "ffmpeg"), linuxResourcePaths.ffmpeg);
}

function isCached(): boolean {
  return (
    fs.existsSync(resourcePaths.ffmpeg) && fs.existsSync(resourcePaths.ytdlp)
  );
}

async function doEnsure(): Promise<void> {
  if (isCached()) {
    return;
  }

  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "karafriends_externalResources"),
  );

  try {
    switch (process.platform) {
      case "win32":
        await installWin(tmpDir);
        break;
      case "darwin":
        await installMacos(tmpDir);
        break;
      default:
        await installLinux(tmpDir);
        break;
    }

    if (process.platform !== "win32") {
      fs.chmodSync(resourcePaths.ffmpeg, 0o755);
      fs.chmodSync(resourcePaths.ytdlp, 0o755);
    }

    if (!isCached()) {
      throw new Error("An external resource wasn't successfully downloaded!");
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

let ensurePromise: Promise<void> | null = null;

// Download and cache the external runtime binaries if they are not already
// present. Idempotent: concurrent and repeat calls share a single in-flight
// download, and a failed attempt is cleared so a later call can retry.
export function ensureExternalResources(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = doEnsure().catch((err) => {
      ensurePromise = null;
      throw err;
    });
  }
  return ensurePromise;
}
