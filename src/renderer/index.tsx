import * as Sentry from "@sentry/browser";
import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";

import React from "react";
import { createRoot } from "react-dom/client"; // tslint:disable-line:no-submodule-imports
import { RelayEnvironmentProvider } from "react-relay";

import environment from "../common/graphqlEnvironment";
import { KuroshiroSingleton } from "../common/joysoundParser";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import "./index.css";
import KarafriendsAudio from "./webAudio";

Sentry.init({
  dsn: "https://80cbda8ca4af42d9b95c60eb1f00566f@sentry.io/6728669",
  debug: true,
});

const kuroshiro = new Kuroshiro();
const kuromojiAnalyzer = new KuromojiAnalyzer({ dictPath: "./dict" });
const kuromojiPromise = kuroshiro.init(kuromojiAnalyzer);

const kuroshiroSingleton: KuroshiroSingleton = {
  kuroshiro,
  analyzer: kuromojiAnalyzer,
  analyzerInitPromise: kuromojiPromise,
};

const audio = new KarafriendsAudio();

const container = document.getElementById("root");
const root = createRoot(container!);

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <RelayEnvironmentProvider environment={environment}>
        <App kuroshiro={kuroshiroSingleton} audio={audio} />
      </RelayEnvironmentProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
