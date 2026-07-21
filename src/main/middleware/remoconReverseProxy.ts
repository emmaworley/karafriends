import path from "path";

import isDev from "electron-is-dev";
import express, { Request, Response } from "express";

function remoconReverseProxy(devPort: number) {
  if (isDev) {
    // On dev, we should proxy non-graphql requests to the remocon dev server
    return (req: Request, res: Response, next: () => void) => {
      if (req.path === "/graphql") {
        next();
        return;
      }
      fetch(
        `http://127.0.0.1:${devPort}/${
          !req.path.startsWith("/remocon") && !req.path.startsWith("/renderer")
            ? "remocon"
            : ""
        }${req.originalUrl}`,
        {
          method: req.method,
          headers: Object.keys(req.headers).map((header): [string, string] => [
            header,
            req.headers[header] as string,
          ]),
        },
      ).then((proxiedRes) => {
        res.status(proxiedRes.status);
        proxiedRes.headers.forEach((value, name) => res.set(name, value));
        proxiedRes.arrayBuffer().then((buf) => {
          res.send(Buffer.from(buf));
        });
      });
    };
  } else {
    // On prod, we can just serve up the built remocon bundle
    return express.static(
      path.join(__dirname, "..", "..", "..", "build", "prod", "remocon"),
    );
  }
}

export default remoconReverseProxy;
