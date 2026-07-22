import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const repoRoot = dirname(fileURLToPath(import.meta.url));

console.log(
  `Dev port: ${process.env.KARAFRIENDS_DEV_PORT}, remocon port: ${process.env.KARAFRIENDS_REMOCON_PORT}`,
);

export const config = {
  capabilities: [
    {
      browserName: "electron",
      "wdio:chromedriverOptions": {
        enableChromeLogs: true,
      },
      "wdio:electronServiceOptions": {
        appBinaryPath: resolve(repoRoot, "electron.js"),
        appArgs: [
          `app=${resolve(repoRoot, "build", "dev", "main_", "index.js")}`,
        ],
      },
    },
  ],
  connectionRetryTimeout: 5 * 60 * 1000,
  framework: "mocha",
  // Run specs one at a time: each spec launches its own Electron app, and the
  // karafriends main process binds the remocon server on a fixed port, so two
  // concurrent instances collide (EADDRINUSE) and one exits.
  maxInstances: 1,
  logLevel: "warn",
  mochaOpts: {
    timeout: 5 * 60 * 1000,
  },
  runner: "local",
  services: ["electron"],
  specs: ["tests/wdio/renderer/**"],
};
