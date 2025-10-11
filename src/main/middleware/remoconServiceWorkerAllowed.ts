import { Request, Response } from "express";

function remoconServiceWorkerAllowed() {
  return (req: Request, res: Response, next: () => void) => {
    res.append("Service-Worker-Allowed", "/");
    next();
  };
}

export default remoconServiceWorkerAllowed;
