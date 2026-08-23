import { buildExample } from "./harness/example.js";

/**
 * Build the example app once, before any scenario is forked: every scenario starts its own
 * Instances from that one build.
 */
export default async function setup(): Promise<void> {
  await buildExample();
}
