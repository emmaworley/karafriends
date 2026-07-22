const assert = require("assert");

// Regression test for the karafriends:// custom protocol. The renderer serves
// downloaded media from karafriends://local/<file>. That scheme must be
// requestable cross-origin from the renderer (a bare custom scheme is blocked
// by Chromium's CORS policy: "Cross origin requests are only supported for
// protocol schemes: ... http, https"), and it must preserve the case-sensitive
// file name (a standard scheme lowercases the URL host, so the name lives in
// the path).
describe("karafriends:// protocol", () => {
  it("serves temp files cross-origin without a CORS block", async () => {
    // Mixed case on purpose: catches the host-lowercasing pitfall where a
    // case-sensitive id (e.g. a YouTube video id) would be mangled.
    const fileName = "wdio-Probe-AbCdEf.mp4";
    const content = "karafriends-scheme-ok";

    // Write the probe into the app's temp folder from the main process.
    await browser.electron.execute(
      (electron, name, body) => {
        // eslint-disable-next-line no-var-requires
        const fs = require("fs");
        // eslint-disable-next-line no-var-requires
        const path = require("path");
        const tempFolder = path.join(
          electron.app.getPath("temp"),
          "karafriends_tmp",
        );
        fs.mkdirSync(tempFolder, { recursive: true });
        fs.writeFileSync(path.join(tempFolder, name), body);
      },
      fileName,
      content,
    );

    // Give the renderer a page (with an origin distinct from karafriends://).
    await browser.url(
      `http://localhost:${process.env.KARAFRIENDS_DEV_PORT}/renderer/`,
    );

    const result = await browser.execute(async (url) => {
      try {
        const resp = await fetch(url);
        return { ok: resp.ok, status: resp.status, text: await resp.text() };
      } catch (e) {
        return { error: String(e) };
      }
    }, `karafriends://local/${fileName}`);

    assert.ok(
      !result.error,
      `fetch of karafriends:// URL failed (CORS/scheme block?): ${result.error}`,
    );
    assert.strictEqual(
      result.ok,
      true,
      `expected an ok response, got status ${result.status}`,
    );
    assert.strictEqual(
      result.text,
      content,
      "protocol served unexpected contents (case-sensitive path handling?)",
    );
  });
});
