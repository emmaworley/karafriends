import { EventEmitter } from "events";
import mdns from "multicast-dns";

import { HOSTNAME } from "../common/constants";
import ipAddresses from "../common/ipAddresses";

export default function setupMdns() {
  const mdnsObj = mdns();
  // The mDNS socket is an EventEmitter; an unhandled "error" event (e.g. a
  // transient network/socket error) would throw and take down the whole app.
  // mDNS is best-effort discovery, so log and keep running instead. (The
  // multicast-dns typings only declare the "query" event, hence the cast.)
  (mdnsObj as unknown as EventEmitter).on("error", (err: unknown) => {
    console.error("mDNS error:", err);
  });
  mdnsObj.on("query", (query: any) => {
    try {
      if (
        query.questions[0] &&
        query.questions[0].name === HOSTNAME &&
        query.questions[0].type === "A"
      ) {
        mdnsObj.respond({
          answers: ipAddresses().map((address) => ({
            name: HOSTNAME,
            type: "A",
            ttl: 300,
            data: address,
          })),
        });
      }
    } catch (err) {
      // Runs in an event-emitter callback, so a throw here is uncaught.
      console.error("Failed to respond to mDNS query:", err);
    }
  });
}
