// This file runs on Node's built-in test runner, not through the app bundle, so
// it uses node: core modules directly.
/* tslint:disable:no-submodule-imports no-implicit-dependencies */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";

import {
  assetPlans,
  canSkipUnvalidated,
  conditionalHeaders,
  extractorFileName,
  hasValidator,
  isStale,
  resourcePathsFor,
  STALE_MS,
  type Platform,
} from "./externalResourcesPlan.ts";

const PLATFORMS: Platform[] = ["win32", "darwin", "linux"];

// Per-platform expectations. These encode the cross-platform contract: the
// binary filenames, download URLs, and unpacking each OS needs.
const EXPECT: Record<
  string,
  {
    extractor: string;
    ffmpeg: string;
    ytdlp: string;
    ytdlpUrl: string;
    ffmpegUrl: string;
    archiveName: string;
    steps: number;
    binary: string[];
  }
> = {
  win32: {
    extractor: "7za.exe",
    ffmpeg: "ffmpeg.exe",
    ytdlp: "yt-dlp.exe",
    ytdlpUrl:
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
    ffmpegUrl: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z",
    archiveName: "ffmpeg.7z",
    steps: 1,
    binary: ["out", "ffmpeg.exe"],
  },
  darwin: {
    extractor: "7za",
    ffmpeg: "ffmpeg",
    ytdlp: "yt-dlp_macos",
    ytdlpUrl:
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
    ffmpegUrl: "https://evermeet.cx/ffmpeg/ffmpeg-6.1.1.zip",
    archiveName: "ffmpeg.zip",
    steps: 1,
    binary: ["out", "ffmpeg"],
  },
  linux: {
    extractor: "7za",
    ffmpeg: "ffmpeg",
    ytdlp: "yt-dlp",
    ytdlpUrl:
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp",
    ffmpegUrl:
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
    archiveName: "ffmpeg.tar.xz",
    steps: 2,
    binary: ["out", "ffmpeg"],
  },
};

describe("extractorFileName", () => {
  test("uses the .exe extractor on Windows and the bare name elsewhere", () => {
    assert.equal(extractorFileName("win32"), "7za.exe");
    assert.equal(extractorFileName("darwin"), "7za");
    assert.equal(extractorFileName("linux"), "7za");
  });
});

describe("resourcePathsFor", () => {
  for (const platform of PLATFORMS) {
    test(`resolves cached binary paths for ${platform}`, () => {
      const cacheDir = path.join("cache", "dir");
      const paths = resourcePathsFor(platform, cacheDir);
      const expected = EXPECT[platform];

      assert.equal(
        paths.ffmpeg,
        path.join(cacheDir, "ffmpeg", expected.ffmpeg),
      );
      assert.equal(paths.ytdlp, path.join(cacheDir, "ytdlp", expected.ytdlp));
    });
  }
});

describe("assetPlans", () => {
  for (const platform of PLATFORMS) {
    const expected = EXPECT[platform];
    const paths = resourcePathsFor(platform, path.join("cache", "dir"));
    const plans = assetPlans(platform, paths);

    test(`${platform}: has a ytdlp binary asset and an ffmpeg archive asset`, () => {
      assert.deepEqual(
        plans.map((p) => p.id),
        ["ytdlp", "ffmpeg"],
      );
    });

    test(`${platform}: plan destinations match resourcePathsFor`, () => {
      const byId = Object.fromEntries(plans.map((p) => [p.id, p]));
      assert.equal(byId.ytdlp.dest, paths.ytdlp);
      assert.equal(byId.ffmpeg.dest, paths.ffmpeg);
    });

    test(`${platform}: ytdlp is a direct binary download from the expected URL`, () => {
      const ytdlp = plans.find((p) => p.id === "ytdlp")!;
      assert.equal(ytdlp.download.kind, "binary");
      assert.equal(ytdlp.url, expected.ytdlpUrl);
    });

    test(`${platform}: ffmpeg is an archive unpacked to the ffmpeg binary`, () => {
      const ffmpeg = plans.find((p) => p.id === "ffmpeg")!;
      assert.equal(ffmpeg.url, expected.ffmpegUrl);
      assert.equal(ffmpeg.download.kind, "archive");

      if (ffmpeg.download.kind !== "archive") return; // narrow for the type checker
      const dl = ffmpeg.download;

      assert.equal(dl.archiveName, expected.archiveName);
      assert.equal(dl.steps.length, expected.steps);
      assert.equal(dl.binary, path.join(...expected.binary));

      // The first pass consumes the downloaded archive, and the final pass
      // produces the directory the binary is read from.
      assert.equal(dl.steps[0].input, dl.archiveName);
      assert.equal(
        dl.steps[dl.steps.length - 1].outDir,
        path.dirname(dl.binary),
      );
    });

    test(`${platform}: every asset URL is https`, () => {
      for (const plan of plans) {
        assert.ok(
          plan.url.startsWith("https://"),
          `${plan.id} url should be https: ${plan.url}`,
        );
      }
    });
  }
});

describe("conditionalHeaders", () => {
  test("sends no headers when the file is not cached", () => {
    assert.deepEqual(conditionalHeaders(false, undefined), {});
    assert.deepEqual(conditionalHeaders(false, { etag: "abc" }), {});
  });

  test("sends no headers when there is no stored validator", () => {
    assert.deepEqual(conditionalHeaders(true, undefined), {});
    assert.deepEqual(conditionalHeaders(true, {}), {});
  });

  test("sends If-None-Match for a stored etag", () => {
    assert.deepEqual(conditionalHeaders(true, { etag: "abc" }), {
      "If-None-Match": "abc",
    });
  });

  test("sends If-Modified-Since for a stored last-modified", () => {
    assert.deepEqual(conditionalHeaders(true, { lastModified: "Mon" }), {
      "If-Modified-Since": "Mon",
    });
  });

  test("sends both validators when both are stored", () => {
    assert.deepEqual(
      conditionalHeaders(true, { etag: "abc", lastModified: "Mon" }),
      { "If-None-Match": "abc", "If-Modified-Since": "Mon" },
    );
  });
});

describe("hasValidator", () => {
  test("is true only when an etag or last-modified is present", () => {
    assert.equal(hasValidator(undefined), false);
    assert.equal(hasValidator({}), false);
    assert.equal(hasValidator({ etag: "abc" }), true);
    assert.equal(hasValidator({ lastModified: "Mon" }), true);
  });
});

describe("canSkipUnvalidated", () => {
  test("never skips when the file is missing", () => {
    assert.equal(canSkipUnvalidated(false, undefined, false), false);
    assert.equal(canSkipUnvalidated(false, { etag: "abc" }, false), false);
  });

  test("skips a fresh cached file that has no validator", () => {
    assert.equal(canSkipUnvalidated(true, undefined, false), true);
    assert.equal(canSkipUnvalidated(true, {}, false), true);
  });

  test("does not skip a stale cached file that has no validator", () => {
    assert.equal(canSkipUnvalidated(true, undefined, true), false);
  });

  test("does not skip when a validator exists (a conditional request is cheap)", () => {
    assert.equal(canSkipUnvalidated(true, { etag: "abc" }, false), false);
    assert.equal(canSkipUnvalidated(true, { etag: "abc" }, true), false);
  });
});

describe("isStale", () => {
  test("is a one week window", () => {
    assert.equal(STALE_MS, 7 * 24 * 60 * 60 * 1000);
  });

  test("is true only once older than the window", () => {
    const now = 10 * STALE_MS;
    assert.equal(isStale(now - STALE_MS - 1, now), true);
    assert.equal(isStale(now - STALE_MS, now), false);
    assert.equal(isStale(now - 1, now), false);
    assert.equal(isStale(now, now), false);
  });

  test("honours a custom window", () => {
    assert.equal(isStale(0, 100, 50), true);
    assert.equal(isStale(60, 100, 50), false);
  });
});
