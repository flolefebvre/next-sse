import type { TestProject } from "vitest/node";

import { provideRedis } from "./valkey-container.js";

/**
 * Provide the integration project with a server, which is all this project needs before its
 * first worker: the contract suite and the two-Instance scenarios run in this process.
 */
export default async function setup(project: TestProject): Promise<(() => Promise<void>) | void> {
  return provideRedis(project);
}
