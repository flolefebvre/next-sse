import { initSSE } from "@flefebvre/next-sse/server";

import { Live } from "./live";

/**
 * The whole app for now: a Server Component that loads the server entry — which resolves only
 * under the `react-server` condition — beside a Client Component that loads the client entry.
 * Nothing is called: v0.1 is a scaffold and every entry point still throws. What this page
 * proves, on every `next build` the e2e suite runs, is that the exports map and the workspace
 * link hold inside a real Next.js build.
 */
export default function Home() {
  return (
    <main>
      <h1>next-sse example app</h1>
      <p data-testid="server-entry">
        {typeof initSSE === "function" ? "server entry loaded" : "server entry missing"}
      </p>
      <Live />
    </main>
  );
}
