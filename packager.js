#!/usr/bin/env yarn node
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const sevenBin = require("7zip-bin");
const packager = require("electron-packager");
const { glob } = require("glob");

// Copy the archive extractor for the target architecture into extraResources/
// so it ships with the app and can unpack the runtime downloads. 7zip-bin lays
// its binaries out as <root>/<platform>/<arch>/7za[.exe]; path7za points at the
// host binary, so we derive the package root from it and pick the target arch.
function bundleExtractor() {
  const arch = process.env.PACKAGER_ARCH || process.arch;
  const platformDir = { darwin: "mac", win32: "win", linux: "linux" }[
    process.platform
  ];
  const binName = process.platform === "win32" ? "7za.exe" : "7za";
  const root = path.resolve(path.dirname(sevenBin.path7za), "..", "..");
  const src = path.join(root, platformDir, arch, binName);
  const dest = path.join("extraResources", binName);
  fs.mkdirSync("extraResources", { recursive: true });
  fs.copyFileSync(src, dest);
  if (process.platform !== "win32") {
    fs.chmodSync(dest, 0o755);
  }
}

(async () => {
  bundleExtractor();
  const buildFiles = new Set([
    "",
    "/package.json",
    "/build",
    ...(await glob("build/prod/**", { posix: true })).map((path) => `/${path}`),
  ]);
  const output = await packager({
    arch: process.env.PACKAGER_ARCH,
    dir: ".",
    extraResource: ["extraResources"],
    ignore: (path) => !buildFiles.has(path),
    out: "dist",
    overwrite: true,
    ...(process.platform === "darwin" && {
      appBundleId: "party.karafriends",
      icon: "appIcons/icon.icns",
      osxNotarize: {
        tool: "notarytool",
        appleApiKey: process.env.NOTARIZATION_KEY_PATH,
        appleApiKeyId: "Z4H7RZ6QUT",
        appleApiIssuer: "69a6de70-1249-47e3-e053-5b8c7c11a4d1",
      },
      osxSign: {
        identity: "Developer ID Application: Emma Worley (WZ6JC3T383)",
      },
    }),
    ...(process.platform === "win32" && {
      icon: "appIcons/icon.ico",
    }),
  });
  console.log(`Built ${output}. Zipping...`);
  spawnSync(sevenBin.path7za, ["a", "-r", `${output}.zip`, output]);
  console.log(`Built ${output}.zip.`);
})();
