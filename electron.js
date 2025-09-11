#!/usr/bin/env -S yarn node
const { spawnSync } = require("child_process");
const { resolve } = require("path");

const electron = require("electron");

const { status } = spawnSync(
  electron,
  process.argv.slice(process.argv.findIndex((arg) => arg === __filename) + 1),
  {
    env: {
      ...process.env,
      NODE_OPTIONS: `--enable-source-maps '--require=${resolve(__dirname, ".pnp.cjs")}' '--experimental-loader=${resolve(__dirname, ".pnp.loader.mjs")}'`,
    },
    stdio: "inherit",
  },
);
console.log(`Electron process finished with status ${status}`);
process.exit(status);
