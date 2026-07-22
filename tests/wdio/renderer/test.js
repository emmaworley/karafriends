const { setupBrowser } = require("@testing-library/webdriverio");
const assert = require("assert");

describe("Electron tests", () => {
  it("Renderer screenshot", async () => {
    const { getByText } = setupBrowser(browser);
    await browser.url(
      `http://localhost:${process.env.KARAFRIENDS_DEV_PORT}/renderer/`,
    );
    await browser.waitUntil(
      async () => {
        try {
          await getByText("Queue");
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 60 * 1000 },
    );
    await browser.saveScreenshot("renderer.png");
  });

  // Regression test for the karafriends:// custom protocol. Downloaded media is
  // served from karafriends://local/<file> and loaded from the renderer (a
  // different origin). The scheme must be requestable cross-origin -- a bare
  // custom scheme is blocked by Chromium ("Cross origin requests are only
  // supported for protocol schemes: ... http, https"), which is what broke
  // video playback -- and it must preserve the case-sensitive file name (a
  // standard scheme lowercases the URL host, so the name lives in the path).
  //
  // We load it as an <img> rather than fetch(): that matches how the app
  // actually loads media (a no-cors subresource load, like <video src>), which
  // succeeds without the file needing CORS response headers. This runs after
  // the screenshot test, reusing its already-loaded renderer page.
  it("serves temp files over the karafriends:// scheme cross-origin", async () => {
    // Mixed case on purpose: catches the host-lowercasing pitfall that would
    // mangle a case-sensitive id (e.g. a YouTube video id).
    const fileName = "wdio-Probe-AbCdEf.png";
    // A valid 1x1 transparent PNG, so <img> decodes it iff the scheme served it.
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

    // Write the probe into the app's temp folder from the main process.
    await browser.electron.execute(
      (electron, name, b64) => {
        // eslint-disable-next-line no-var-requires
        const fs = require("fs");
        // eslint-disable-next-line no-var-requires
        const path = require("path");
        const dir = path.join(electron.app.getPath("temp"), "karafriends_tmp");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), Buffer.from(b64, "base64"));
      },
      fileName,
      pngBase64,
    );

    const loaded = await browser.executeAsync((url, done) => {
      const img = new Image();
      img.onload = () => done(true);
      img.onerror = () => done(false);
      img.src = url;
      setTimeout(() => done(false), 10 * 1000);
    }, `karafriends://local/${fileName}`);

    assert.strictEqual(
      loaded,
      true,
      "karafriends:// resource was blocked (CORS/scheme) or failed to load",
    );
  });
});
