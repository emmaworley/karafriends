const { setupBrowser } = require("@testing-library/webdriverio");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

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

    // The protocol handler serves app.getPath("temp")/karafriends_tmp/<file>.
    // Ask the main process for that temp dir, then write the probe from here
    // (the WDIO Node process) -- the bundled main context doesn't expose
    // require(), so writing from inside browser.electron.execute doesn't work.
    const tempDir = await browser.electron.execute((electron) =>
      electron.app.getPath("temp"),
    );
    const dir = path.join(tempDir, "karafriends_tmp");
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, fileName);
    fs.writeFileSync(full, Buffer.from(pngBase64, "base64"));
    const probe = { full, exists: fs.existsSync(full) };

    const res = await browser.executeAsync((url, done) => {
      const out = { origin: location.origin };
      let pending = 2;
      const settle = () => {
        if (--pending === 0) done(out);
      };
      const img = new Image();
      img.onload = () => {
        out.img = "load";
        settle();
      };
      img.onerror = () => {
        out.img = "error";
        settle();
      };
      img.src = url;
      // no-cors mirrors how the app loads media; used here only for diagnostics.
      fetch(url, { mode: "no-cors" })
        .then((r) => {
          out.noCorsFetch = `type=${r.type} status=${r.status}`;
          settle();
        })
        .catch((e) => {
          out.noCorsFetch = `throw:${e}`;
          settle();
        });
      setTimeout(() => done(out), 8 * 1000);
    }, `karafriends://local/${fileName}`);

    assert.strictEqual(
      res.img,
      "load",
      `karafriends:// load failed. probe=${JSON.stringify(probe)} result=${JSON.stringify(res)}`,
    );
  });
});
