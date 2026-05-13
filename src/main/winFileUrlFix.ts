// Workaround for a Parcel-on-Windows interaction. Parcel inlines
// `import.meta.url` in the main bundle as a relative file URL
// ("file:///.yarn/cache/...") with no drive letter. Linux/macOS treats the
// leading "/" as the filesystem root and `fileURLToPath` accepts it; Windows
// requires an absolute path with a drive letter and throws
// ERR_INVALID_FILE_URL_PATH. Dependencies (e.g. youtubei.js) call
// `fileURLToPath(import.meta.url)` at module top-level and crash the main
// process at startup.
//
// On Windows only, wrap `url.fileURLToPath` to fall back to the input string
// with the "file://" prefix stripped when it would otherwise throw the
// above error — the same path Linux/macOS would have produced. This must be
// imported before any module that uses fileURLToPath (see main/index.ts).

import * as nodeUrl from "url";

if (process.platform === "win32") {
  const url = nodeUrl as {
    fileURLToPath: (input: string | URL) => string;
  };
  const original = url.fileURLToPath;
  url.fileURLToPath = (input: string | URL): string => {
    try {
      return original(input);
    } catch (e: unknown) {
      if (
        (e as NodeJS.ErrnoException | undefined)?.code ===
        "ERR_INVALID_FILE_URL_PATH"
      ) {
        const str = typeof input === "string" ? input : input.toString();
        return str.replace(/^file:\/\//, "");
      }
      throw e;
    }
  };
}
