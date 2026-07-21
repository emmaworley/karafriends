import { execFile } from "child_process";
import { app } from "electron"; // tslint:disable-line:no-implicit-dependencies
import fs, { promises as fsp } from "fs";
import os from "os";
import path from "path";
import process from "process";
import { promisify } from "util";

import fetch, { Response as FetchResponse } from "node-fetch";

import {
  AssetPlan,
  assetPlans,
  canSkipUnvalidated,
  conditionalHeaders,
  extractorFileName,
  isStale,
  ResourcePaths,
  resourcePathsFor,
  Versions,
} from "./externalResourcesPlan";

const execFileAsync = promisify(execFile);

// External runtime binaries are downloaded lazily on the user's machine and
// cached here so they are fetched once and reused across launches, instead of
// being bundled into every build. They still need to stay current: the upstream
// tools update frequently (some are pinned to a "latest" release), so on each
// launch we ask the server whether a newer version exists and refresh only when
// it does. The archive extractor is the only piece that ships with the app (see
// extraResources), because we need it to unpack these downloads at runtime.
//
// The pure planning and decision logic lives in externalResourcesPlan.ts so it
// can be unit tested across platforms without electron, the filesystem, or the
// network; this module wires that plan up to the real side effects.
const isDev = process.env.NODE_ENV === "development";

const extractorDir = isDev
  ? path.join(app.getAppPath(), "..", "..", "..", "extraResources")
  : path.join(process.resourcesPath, "extraResources");

const extractorPath = path.join(
  extractorDir,
  extractorFileName(process.platform),
);

const cacheDir = path.join(app.getPath("userData"), "externalResources");
const versionsFile = path.join(cacheDir, "versions.json");

const resourcePaths: ResourcePaths = resourcePathsFor(
  process.platform,
  cacheDir,
);

export function getResourcePaths(): ResourcePaths {
  return resourcePaths;
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

// Download an asset into `tmpDir`, unpack it per its plan, and return the path
// of the finished binary to move into place.
async function materialize(
  plan: AssetPlan,
  tmpDir: string,
  res: FetchResponse,
): Promise<string> {
  if (plan.download.kind === "binary") {
    const bin = path.join(tmpDir, "bin");
    await streamToFile(res, bin);
    return bin;
  }

  const { archiveName, steps, binary } = plan.download;
  await streamToFile(res, path.join(tmpDir, archiveName));
  for (const step of steps) {
    await extract(
      path.join(tmpDir, step.input),
      path.join(tmpDir, step.outDir),
    );
  }
  return path.join(tmpDir, binary);
}

function mtimeMs(dest: string): number {
  try {
    return fs.statSync(dest).mtimeMs;
  } catch {
    return 0;
  }
}

// Make sure a single asset is present and up to date. Returns true when the
// cached copy changed (so the version metadata needs to be persisted).
async function ensureAsset(
  plan: AssetPlan,
  versions: Versions,
): Promise<boolean> {
  const exists = fs.existsSync(plan.dest);
  const stored = versions[plan.id];
  const stale = exists ? isStale(mtimeMs(plan.dest), Date.now()) : true;

  // Without a stored validator we cannot make a conditional request, so a plain
  // GET would re-download every launch. Skip until the cached copy is stale.
  if (canSkipUnvalidated(exists, stored, stale)) {
    return false;
  }

  let res: FetchResponse;
  try {
    res = await fetchAsset(plan.url, conditionalHeaders(exists, stored), 5);
  } catch (err) {
    // Offline or the server is unreachable. Keep whatever we already have; only
    // fail if there is nothing cached to fall back on.
    if (exists) {
      console.error(`Keeping cached ${plan.id}; version check failed: ${err}`);
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
    const src = await materialize(plan, tmpDir, res);
    await finalize(src, plan.dest);
    if (process.platform !== "win32") {
      fs.chmodSync(plan.dest, 0o755);
    }
  } catch (err) {
    // A failed refresh must not destroy a working cached copy.
    if (exists) {
      console.error(`Keeping cached ${plan.id}; update failed: ${err}`);
      return false;
    }
    throw err;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  versions[plan.id] = {
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
  };
  return true;
}

async function doEnsure(): Promise<void> {
  const plans = assetPlans(process.platform, resourcePaths);
  const versions = readVersions();

  const changed = await Promise.all(
    plans.map((plan) => ensureAsset(plan, versions)),
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
