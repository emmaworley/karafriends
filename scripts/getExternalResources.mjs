#!/usr/bin/node
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import process from "process";
import { promisify } from "util";

import sevenBin from "7zip-bin";
import fetch from "node-fetch";

// The large media binaries are downloaded lazily at runtime and cached on the
// user's machine (see src/common/externalResources.ts), so they are no longer
// fetched at build time. This script only prepares build-time resources:
//   * the archive extractor, copied into extraResources/ so it ships with the
//     app and can unpack the runtime downloads
//   * the Windows ASIO SDK, a compile-time dependency of the native module

const execFileAsync = promisify(execFile);

const pathTo7zip = sevenBin.path7za;
// 7zip-bin ships the unix `7za` without the executable bit under Yarn PnP, so
// spawning it fails with EACCES. Restore the executable bit. (No-op on Windows,
// and harmless for versions that already set it.)
if (process.platform !== "win32") {
  try {
    fs.chmodSync(pathTo7zip, 0o755);
  } catch {
    // best-effort; extraction will surface a clearer error if this fails
  }
}

const extraResourcesDir = `${process.cwd()}/extraResources`;
const buildResourcesDir = `${process.cwd()}/buildResources`;

async function fetchWithRetries(url, retries) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff between attempts. Some hosts (e.g. CDNs that
      // rate-limit CI IPs) reset the connection instead of returning an HTTP
      // error, so we must retry on thrown network errors too, not just on
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

async function downloadFile(url, dest) {
  const res = await fetchWithRetries(url, 5);
  const fileStream = fs.createWriteStream(dest);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on("error", reject);
    fileStream.on("finish", resolve);
  });
}

// Copy the archive extractor into extraResources/ so it ships with the app and
// can unpack the runtime downloads. Uses the host architecture, which is what
// runs in development and on the per-arch CI machines; the packager copies the
// target-architecture extractor for production builds.
function copyExtractor() {
  fs.mkdirSync(extraResourcesDir, { recursive: true });
  const dest = path.join(
    extraResourcesDir,
    process.platform === "win32" ? "7za.exe" : "7za",
  );
  fs.copyFileSync(pathTo7zip, dest);
  if (process.platform !== "win32") {
    fs.chmodSync(dest, 0o755);
  }
}

// The ASIO SDK is a Windows-only compile-time dependency of the native module.
async function getAsioSdk() {
  const asioHeader = `${buildResourcesDir}/asio/asiosdk/common/asio.h`;
  if (fs.existsSync(asioHeader)) {
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "karafriends_asio"));
  const archive = path.join(tmpDir, "asio.zip");
  fs.mkdirSync(`${buildResourcesDir}/asio`, { recursive: true });
  try {
    await downloadFile("https://www.steinberg.net/asiosdk", archive);
    await execFileAsync(pathTo7zip, [
      "x",
      archive,
      "-y",
      `-o${buildResourcesDir}/asio`,
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  if (!fs.existsSync(asioHeader)) {
    console.error("The ASIO SDK wasn't successfully downloaded!");
    process.exit(1);
  }
}

copyExtractor();

if (process.platform === "win32") {
  await getAsioSdk();
}
