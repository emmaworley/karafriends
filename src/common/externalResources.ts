import { execFile } from "child_process";
import { app } from "electron"; // tslint:disable-line:no-implicit-dependencies
import fs, { promises as fsp } from "fs";
import os from "os";
import path from "path";
import process from "process";
import { promisify } from "util";

import fetch, { Response as FetchResponse } from "node-fetch";

const execFileAsync = promisify(execFile);

// External runtime binaries are downloaded lazily on the user's machine and
// cached here so they are fetched once and reused across launches, instead of
// being bundled into every build. They still need to stay current: the upstream
// tools update frequently (some are pinned to a "latest" release), so on each
// launch we ask the server whether a newer version exists and refresh only when
// it does. The archive extractor is the only piece that ships with the app (see
// extraResources), because we need it to unpack these downloads at runtime.
const isDev = process.env.NODE_ENV === "development";

const extractorDir = isDev
  ? path.join(app.getAppPath(), "..", "..", "..", "extraResources")
  : path.join(process.resourcesPath, "extraResources");

const extractorPath = path.join(
  extractorDir,
  process.platform === "win32" ? "7za.exe" : "7za",
);

const cacheDir = path.join(app.getPath("userData"), "externalResources");
const versionsFile = path.join(cacheDir, "versions.json");

// When the server exposes no cache validators for an asset, fall back to
// refreshing the cached copy once it is older than this, so we neither
// re-download it on every launch nor let it go stale forever.
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

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

// An HTTP cache validator for a downloaded asset. Persisted between launches so
// we can make a conditional request and skip the download when it is unchanged.
interface Validator {
  etag?: string;
  lastModified?: string;
}

type Versions = Record<string, Validator>;

// A single downloadable binary. `materialize` streams an already-fetched 200
// response into `tmpDir`, unpacks it if necessary, and returns the path of the
// finished binary to move into place.
interface Asset {
  id: string;
  url: string;
  dest: string;
  materialize: (tmpDir: string, res: FetchResponse) => Promise<string>;
}

function readVersions(): Versions {
  try {
    return JSON.parse(fs.readFileSync(versionsFile, "utf8"));
  } catch {
    return {};
  }
}

async function writeVersions(versions: Versions): Promise<void> {
  await fsp.mkdir(cacheDir, { recursive: true });
  await fsp.writeFile(versionsFile, JSON.stringify(versions, null, 2));
}

// Fetch accepting both 200 (changed / first download) and 304 (unchanged), with
// exponential backoff. Some hosts (e.g. CDNs that rate-limit certain IPs) reset
// the connection instead of returning an HTTP error, so we retry on thrown
// network errors too, not just on non-ok responses.
async function fetchAsset(
  url: string,
  headers: Record<string, string>,
  retries: number,
): Promise<FetchResponse> {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
    try {
      const res = await fetch(url, { headers });
      if (res.ok || res.status === 304) {
        return res;
      }
      lastError = new Error(String(res.status));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function streamToFile(res: FetchResponse, dest: string): Promise<void> {
  const fileStream = fs.createWriteStream(dest);
  await new Promise<void>((resolve, reject) => {
    res.body!.pipe(fileStream);
    res.body!.on("error", reject);
    fileStream.on("finish", () => resolve());
  });
}

// Move a finished binary into its final cached location atomically: write to a
// sibling temp file (same directory, so the rename stays on one filesystem) and
// rename into place last. An interrupted refresh therefore never leaves a file
// that looks complete, and never corrupts the copy already in use.
async function finalize(src: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.part`;
  await fsp.copyFile(src, partial);
  await fsp.rename(partial, dest);
}

async function extract(archive: string, outDir: string): Promise<void> {
  await execFileAsync(extractorPath, ["e", archive, "-y", `-o${outDir}`]);
}

function binaryAsset(id: string, url: string, dest: string): Asset {
  return {
    id,
    url,
    dest,
    materialize: async (tmpDir, res) => {
      const bin = path.join(tmpDir, "bin");
      await streamToFile(res, bin);
      return bin;
    },
  };
}

function archiveAsset(
  id: string,
  url: string,
  dest: string,
  archiveName: string,
  // Unpack the downloaded archive and return the path of the extracted binary.
  unpack: (tmpDir: string, archive: string) => Promise<string>,
): Asset {
  return {
    id,
    url,
    dest,
    materialize: async (tmpDir, res) => {
      const archive = path.join(tmpDir, archiveName);
      await streamToFile(res, archive);
      return unpack(tmpDir, archive);
    },
  };
}

function platformAssets(): Asset[] {
  switch (process.platform) {
    case "win32":
      return [
        binaryAsset(
          "ytdlp",
          "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
          winResourcePaths.ytdlp,
        ),
        archiveAsset(
          "ffmpeg",
          "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z",
          winResourcePaths.ffmpeg,
          "ffmpeg.7z",
          async (tmpDir, archive) => {
            const out = path.join(tmpDir, "out");
            await extract(archive, out);
            return path.join(out, "ffmpeg.exe");
          },
        ),
      ];
    case "darwin":
      return [
        binaryAsset(
          "ytdlp",
          "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
          macosResourcePaths.ytdlp,
        ),
        archiveAsset(
          "ffmpeg",
          "https://evermeet.cx/ffmpeg/ffmpeg-6.1.1.zip",
          macosResourcePaths.ffmpeg,
          "ffmpeg.zip",
          async (tmpDir, archive) => {
            const out = path.join(tmpDir, "out");
            await extract(archive, out);
            return path.join(out, "ffmpeg");
          },
        ),
      ];
    default:
      return [
        binaryAsset(
          "ytdlp",
          "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp",
          linuxResourcePaths.ytdlp,
        ),
        archiveAsset(
          "ffmpeg",
          // GitHub-hosted static build; johnvansickle.com resets connections
          // from some IPs. Flat extraction still yields the ffmpeg binary.
          "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
          linuxResourcePaths.ffmpeg,
          "ffmpeg.tar.xz",
          async (tmpDir, archive) => {
            // .tar.xz needs two passes: first to the .tar, then to the contents.
            const tarOut = path.join(tmpDir, "tar");
            const out = path.join(tmpDir, "out");
            await extract(archive, tarOut);
            await extract(path.join(tarOut, "ffmpeg.tar"), out);
            return path.join(out, "ffmpeg");
          },
        ),
      ];
  }
}

function isStale(dest: string): boolean {
  try {
    return Date.now() - fs.statSync(dest).mtimeMs > STALE_MS;
  } catch {
    return true;
  }
}

// Make sure a single asset is present and up to date. Returns true when the
// cached copy changed (so the version metadata needs to be persisted).
async function ensureAsset(asset: Asset, versions: Versions): Promise<boolean> {
  const exists = fs.existsSync(asset.dest);
  const stored = versions[asset.id] ?? {};
  const canValidate = Boolean(stored.etag || stored.lastModified);

  // Without a stored validator we cannot make a conditional request, so a plain
  // GET would re-download every launch. Skip until the cached copy is stale.
  if (exists && !canValidate && !isStale(asset.dest)) {
    return false;
  }

  const headers: Record<string, string> = {};
  if (exists && stored.etag) {
    headers["If-None-Match"] = stored.etag;
  }
  if (exists && stored.lastModified) {
    headers["If-Modified-Since"] = stored.lastModified;
  }

  let res: FetchResponse;
  try {
    res = await fetchAsset(asset.url, headers, 5);
  } catch (err) {
    // Offline or the server is unreachable. Keep whatever we already have; only
    // fail if there is nothing cached to fall back on.
    if (exists) {
      console.error(`Keeping cached ${asset.id}; version check failed: ${err}`);
      return false;
    }
    throw err;
  }

  if (res.status === 304) {
    return false;
  }

  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "karafriends_externalResources"),
  );
  try {
    const src = await asset.materialize(tmpDir, res);
    await finalize(src, asset.dest);
    if (process.platform !== "win32") {
      fs.chmodSync(asset.dest, 0o755);
    }
  } catch (err) {
    // A failed refresh must not destroy a working cached copy.
    if (exists) {
      console.error(`Keeping cached ${asset.id}; update failed: ${err}`);
      return false;
    }
    throw err;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  versions[asset.id] = {
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
  };
  return true;
}

async function doEnsure(): Promise<void> {
  const assets = platformAssets();
  const versions = readVersions();

  const changed = await Promise.all(
    assets.map((asset) => ensureAsset(asset, versions)),
  );

  if (changed.some(Boolean)) {
    await writeVersions(versions);
  }

  if (
    !fs.existsSync(resourcePaths.ffmpeg) ||
    !fs.existsSync(resourcePaths.ytdlp)
  ) {
    throw new Error("An external resource wasn't successfully downloaded!");
  }
}

let ensurePromise: Promise<void> | null = null;

// Make sure the external runtime binaries are present and up to date, fetching
// or refreshing them as needed. Runs its checks once per launch: concurrent and
// repeat calls within a launch share a single in-flight promise, and a failed
// attempt is cleared so a later call can retry.
export function ensureExternalResources(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = doEnsure().catch((err) => {
      ensurePromise = null;
      throw err;
    });
  }
  return ensurePromise;
}
