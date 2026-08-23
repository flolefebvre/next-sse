/**
 * The one body every v0.1 stub has. The scaffold ships the whole public surface of ADR-0008
 * so that the exports map, the gate and the example app are proven before any protocol code
 * exists; each entry point's real implementation replaces its own stub without the map, the
 * manifest or a consumer's import ever changing.
 */
export function notImplemented(name: string): never {
  throw new Error(
    `${name} is not implemented: @flefebvre/next-sse 0.1.0 is a scaffold and carries no protocol yet.`,
  );
}
