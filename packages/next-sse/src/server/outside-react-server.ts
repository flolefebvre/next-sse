/**
 * What `@flefebvre/next-sse/server` resolves to under every condition but `react-server`.
 *
 * The Registry is server-only: it holds the App's Authorize code and the Transport. A Client
 * Component that imports it must fail at module load in every layer, Client-Component SSR
 * included, which a `browser`-only stub does not cover — so the failure is a throw in the
 * module body, and the manifest lists this file under `sideEffects` to keep a bundler from
 * eliding it when only types are imported.
 */
throw new Error(
  "@flefebvre/next-sse/server was imported outside the react-server condition. It is server-only: " +
    "import it from a Server Component, a route handler or other server code, and import " +
    "@flefebvre/next-sse/client from Client Components.",
);

export {};
