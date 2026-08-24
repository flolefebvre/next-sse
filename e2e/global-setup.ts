import type { TestProject } from "vitest/node";

import { provideRedis } from "../tests/valkey-container.js";

import { buildExample } from "./harness/example.js";

/**
 * What the whole run shares, made once before any scenario is forked: the built example app,
 * and the one server every Instance of every scenario talks to.
 *
 * One container for the run rather than one per scenario — starting a server takes longer than
 * most scenarios do — and scenarios stay out of each other's way by holding a Prefix of their
 * own instead (ADR-0009), which is the only thing keeping two Apps apart on a shared server
 * anyway. The build comes first: a run that cannot build the app has no use for a server, and
 * this way there is never one running with no teardown to stop it.
 */
export default async function setup(project: TestProject): Promise<(() => Promise<void>) | void> {
  await buildExample();

  return provideRedis(project);
}
