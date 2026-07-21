import { fileURLToPath } from "url";

// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import { default as nativeAudioUrl } from "url:../../native/index.node";
const nativeAudio = require(fileURLToPath(nativeAudioUrl)); // tslint:disable-line:no-var-requires

import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: "https://80cbda8ca4af42d9b95c60eb1f00566f@sentry.io/6728669",
  debug: true,
});

async function handleError(err: unknown) {
  console.error("Fatal error:", err);
  Sentry.captureException(err);
  await Sentry.close(10 * 1000);
  process.exit(1);
}

process.on("uncaughtException", handleError);
process.on("unhandledRejection", handleError);

import inspector from "inspector";

// Start a debug server if we don't have one already. If we already have one, this would throw.
if (inspector.url() === undefined) inspector.open();

import path from "path";

import compression from "compression";
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  IpcMainEvent,
  protocol,
} from "electron"; // tslint:disable-line:no-implicit-dependencies
import isDev from "electron-is-dev";
import express from "express";

import karafriendsConfig from "../common/config";
import { ensureExternalResources } from "./../common/externalResources";
import { TEMP_FOLDER } from "./../common/videoDownloader";
import { MinseiAPI } from "./damApi";
import { applyGraphQLMiddleware } from "./graphql";
import { JoysoundAPI } from "./joysoundApi";
import setupMdns from "./mdns";
import remoconReverseProxy from "./middleware/remoconReverseProxy";
import remoconServiceWorkerAllowed from "./middleware/remoconServiceWorkerAllowed";

// tslint:disable-next-line:no-submodule-imports no-implicit-dependencies
import { default as preloadUrl } from "url:../preload";

try {
  nativeAudio.allocConsole();
} catch (e) {
  console.error(e);
}

setupMdns();

protocol.registerSchemesAsPrivileged([
  {
    scheme: "karafriends",
    privileges: {
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

let rendererWindow: BrowserWindow | null;

function createWindow() {
  rendererWindow = new BrowserWindow({
    frame: isDev,
    fullscreen: !isDev,
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      preload: fileURLToPath(preloadUrl),
      sandbox: false,
      webSecurity: true,
    },
  });

  // A renderer crash (GPU reset, OOM, native fault) would otherwise leave the
  // karaoke display permanently blank. Reload the window so the show goes on.
  rendererWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`Renderer process gone (${details.reason})`);
    if (details.reason !== "clean-exit") {
      rendererWindow?.reload();
    }
  });

  // Ignore CORS when fetching ipcasting HLS and when sending requests to remocon
  const session = rendererWindow.webContents.session;
  const ignoreCORSFilter = {
    urls: [
      "https://*.ipcasting.jp/*",
      `http://localhost:${karafriendsConfig.remoconPort}/*`, // TODO: Set CORS headers on the Express side and remove this
    ],
  };

  session.webRequest.onBeforeSendHeaders(
    ignoreCORSFilter,
    (details, callback) => {
      delete details.requestHeaders.Origin;
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  session.webRequest.onHeadersReceived(
    ignoreCORSFilter,
    (details, callback) => {
      // Chrome is not happy if ACAO is set twice, which is what happens
      // when the Express static middleware is setting this one
      if (details.responseHeaders) {
        delete details.responseHeaders["access-control-allow-origin"];
        details.responseHeaders["Access-Control-Allow-Origin"] = ["*"];
      }
      callback({ responseHeaders: details.responseHeaders });
    },
  );

  if (karafriendsConfig.proxyEnable) {
    session
      .setProxy({
        proxyRules: `${karafriendsConfig.proxyHost}:${karafriendsConfig.proxyPort}`,
        proxyBypassRules: "<local>,192.168.0.0/16,172.16.0.0/12,10.0.0.0/8",
      })
      .catch((err) => console.error("Failed to set proxy:", err));
  }

  protocol.registerFileProtocol("karafriends", (request, callback) => {
    console.log(`Got protocol request: ${request.method} ${request.url}`);
    const url = request.url.substr(14 /* 'karafriends://'.length */);
    callback({ path: path.normalize(`${TEMP_FOLDER}/${url}`) });
  });

  const expressApp = express();

  expressApp.use(compression());

  applyGraphQLMiddleware(expressApp);

  expressApp.use(remoconServiceWorkerAllowed());

  // This middleware terminates the request/response cycle and should be applied last
  expressApp.use(remoconReverseProxy(karafriendsConfig.devPort));

  if (rendererWindow) {
    const rendererUrl = isDev
      ? `http://localhost:${karafriendsConfig.devPort}/renderer/`
      : `file://${path.join(__dirname, "..", "..", "build", "prod", "renderer", "index.html")}`;
    // A failed load (dev server not ready, a transient file/protocol error)
    // would leave the karaoke display blank, and the unhandled loadURL
    // rejection would reach the process-level handler. Catch it and retry a few
    // times so the show still comes up.
    let rendererLoadAttempts = 0;
    const loadRenderer = () => {
      rendererWindow
        ?.loadURL(rendererUrl)
        .catch((err) =>
          console.error(`Failed to load renderer ${rendererUrl}:`, err),
        );
    };
    rendererWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, _url, isMainFrame) => {
        // -3 (ERR_ABORTED) is a benign navigation cancel, not a real failure.
        if (!isMainFrame || errorCode === -3) return;
        console.error(
          `Renderer failed to load (${errorCode} ${errorDescription})`,
        );
        if (rendererLoadAttempts++ < 10) {
          setTimeout(loadRenderer, 1000);
        }
      },
    );
    loadRenderer();
  }

  ipcMain.on("config", (event: IpcMainEvent) => {
    console.log("Sending config over ipc");
    event.returnValue = karafriendsConfig;
  });
}

app.on("ready", () => {
  // Start warming the external resource cache as soon as the app is ready so
  // the binaries are usually in place before the first song is queued. This is
  // best-effort: failures are logged and retried on demand by the downloader,
  // and must be caught here so the unhandledRejection handler doesn't exit.
  ensureExternalResources().catch((err) =>
    console.error(`Error preparing external resources: ${err}`),
  );
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (rendererWindow === null) {
    createWindow();
  }
});

function refreshRendererWindow() {
  if (!rendererWindow) return;
  if (
    dialog.showMessageBoxSync(rendererWindow, {
      message: "Are you sure you want to reload the renderer window?",
      buttons: ["Reload", "Cancel"],
    }) === 0
  ) {
    rendererWindow.reload();
  }
}

app.on("browser-window-focus", () => {
  globalShortcut.register("CommandOrControl+R", refreshRendererWindow);
  globalShortcut.register("F5", refreshRendererWindow);
});

app.on("browser-window-blur", () => {
  globalShortcut.unregister("CommandOrControl+R");
  globalShortcut.unregister("F5");
});

app.on("login", (event, webContents, request, authInfo, callback) => {
  console.log(
    `login event received: authinfo=${authInfo} callback=${callback}`,
  );
  if (karafriendsConfig.proxyEnable) {
    const { proxyHost, proxyPort, proxyUser, proxyPass } = karafriendsConfig;
    console.log(`Time to login to ${proxyHost}:${proxyPort}`);
    callback(proxyUser, proxyPass);
    event.preventDefault();
  } else {
    // Well that's strange...
    console.log("Received login event even though proxy is not enabled?");
    if (rendererWindow) {
      dialog.showMessageBoxSync(rendererWindow, {
        message:
          "Received login event even though proxy is not enabled. Proceed with caution",
      });
    }
  }
});
