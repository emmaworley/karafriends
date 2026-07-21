import path from "path";

// Pure, dependency-free planning and decision logic for the external runtime
// binaries. It is kept separate from externalResources.ts (which touches
// electron, the filesystem and the network) so the cross-platform behaviour can
// be unit tested without any of those side effects.

export type Platform = NodeJS.Platform;

export interface ResourcePaths {
  // Path to the ffmpeg executable
  ffmpeg: string;
  // Path to the ytdlp executable
  ytdlp: string;
}

// An HTTP cache validator for a downloaded asset. Persisted between launches so
// we can make a conditional request and skip the download when it is unchanged.
export interface Validator {
  etag?: string;
  lastModified?: string;
}

export type Versions = Record<string, Validator>;

// One extraction pass: unpack `input` (relative to the temp dir) into `outDir`
// (relative to the temp dir). Archives that need multiple passes (e.g. .tar.xz)
// list several steps, each consuming a file produced by the previous one.
export interface ExtractStep {
  input: string;
  outDir: string;
}

export type Download =
  | { kind: "binary" }
  | {
      kind: "archive";
      // Temp filename to stream the downloaded archive into.
      archiveName: string;
      steps: ExtractStep[];
      // Path of the extracted binary, relative to the temp dir.
      binary: string;
    };

export interface AssetPlan {
  id: "ytdlp" | "ffmpeg";
  url: string;
  dest: string;
  download: Download;
}

// Refresh the cached copy once it is older than this when the server exposes no
// cache validators, so it neither re-downloads on every launch nor goes stale
// forever.
export const STALE_MS = 7 * 24 * 60 * 60 * 1000;

const YTDLP_BASE =
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

export function extractorFileName(platform: Platform): string {
  return platform === "win32" ? "7za.exe" : "7za";
}

export function resourcePathsFor(
  platform: Platform,
  cacheDir: string,
): ResourcePaths {
  const ffmpegName = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const ytdlpName =
    platform === "win32"
      ? "yt-dlp.exe"
      : platform === "darwin"
        ? "yt-dlp_macos"
        : "yt-dlp";
  return {
    ffmpeg: path.join(cacheDir, "ffmpeg", ffmpegName),
    ytdlp: path.join(cacheDir, "ytdlp", ytdlpName),
  };
}

// The downloadable assets for a platform: their URLs, final destinations, and
// how (if at all) each download is unpacked.
export function assetPlans(
  platform: Platform,
  paths: ResourcePaths,
): AssetPlan[] {
  switch (platform) {
    case "win32":
      return [
        {
          id: "ytdlp",
          url: `${YTDLP_BASE}.exe`,
          dest: paths.ytdlp,
          download: { kind: "binary" },
        },
        {
          id: "ffmpeg",
          url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z",
          dest: paths.ffmpeg,
          download: {
            kind: "archive",
            archiveName: "ffmpeg.7z",
            steps: [{ input: "ffmpeg.7z", outDir: "out" }],
            binary: path.join("out", "ffmpeg.exe"),
          },
        },
      ];
    case "darwin":
      return [
        {
          id: "ytdlp",
          url: `${YTDLP_BASE}_macos`,
          dest: paths.ytdlp,
          download: { kind: "binary" },
        },
        {
          id: "ffmpeg",
          url: "https://evermeet.cx/ffmpeg/ffmpeg-6.1.1.zip",
          dest: paths.ffmpeg,
          download: {
            kind: "archive",
            archiveName: "ffmpeg.zip",
            steps: [{ input: "ffmpeg.zip", outDir: "out" }],
            binary: path.join("out", "ffmpeg"),
          },
        },
      ];
    default:
      return [
        {
          id: "ytdlp",
          url: YTDLP_BASE,
          dest: paths.ytdlp,
          download: { kind: "binary" },
        },
        {
          id: "ffmpeg",
          // GitHub-hosted static build; johnvansickle.com resets connections
          // from some IPs. Flat extraction still yields the ffmpeg binary.
          url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
          dest: paths.ffmpeg,
          download: {
            kind: "archive",
            archiveName: "ffmpeg.tar.xz",
            // .tar.xz needs two passes: first to the .tar, then to the contents.
            steps: [
              { input: "ffmpeg.tar.xz", outDir: "tar" },
              { input: path.join("tar", "ffmpeg.tar"), outDir: "out" },
            ],
            binary: path.join("out", "ffmpeg"),
          },
        },
      ];
  }
}

export function hasValidator(stored: Validator | undefined): boolean {
  return Boolean(stored?.etag || stored?.lastModified);
}

// Conditional-request headers for an asset we already have on disk, so the
// server can answer 304 Not Modified when the cached copy is still current.
export function conditionalHeaders(
  exists: boolean,
  stored: Validator | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (exists && stored?.etag) {
    headers["If-None-Match"] = stored.etag;
  }
  if (exists && stored?.lastModified) {
    headers["If-Modified-Since"] = stored.lastModified;
  }
  return headers;
}

export function isStale(
  mtimeMs: number,
  nowMs: number,
  staleMs: number = STALE_MS,
): boolean {
  return nowMs - mtimeMs > staleMs;
}

// Whether the network can be skipped entirely: the file is present, there is no
// validator to make a conditional request with, and the cached copy is fresh.
// Downloading anyway would re-fetch the asset on every launch.
export function canSkipUnvalidated(
  exists: boolean,
  stored: Validator | undefined,
  stale: boolean,
): boolean {
  return exists && !hasValidator(stored) && !stale;
}
