"use client";

import { createClient } from "@flefebvre/next-sse/client";

/** The client half of the same proof: the entry a browser bundle loads. */
export function Live() {
  return (
    <p data-testid="client-entry">
      {typeof createClient === "function" ? "client entry loaded" : "client entry missing"}
    </p>
  );
}
