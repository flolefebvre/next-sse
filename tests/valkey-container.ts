import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

/**
 * The server the integration project runs against unless `NEXT_SSE_TEST_IMAGE` says
 * otherwise. The only place an image is named.
 */
export const DEFAULT_TEST_IMAGE = "valkey/valkey:8";

const REDIS_PORT = 6379;

/** A running server, and the way to stop it. */
export interface RunningRedis {
  url: string;
  stop(): Promise<void>;
}

/**
 * The image to start: `NEXT_SSE_TEST_IMAGE` when it holds something, the default otherwise.
 * An empty variable counts as unset, so an unfilled CI matrix input falls back rather than
 * failing on an empty image name.
 */
export function testImage(env: NodeJS.ProcessEnv = process.env): string {
  return env.NEXT_SSE_TEST_IMAGE?.trim() || DEFAULT_TEST_IMAGE;
}

/**
 * The server to use instead of a container: `NEXT_SSE_TEST_REDIS_URL` when it holds
 * something. When it is set no container is started, which is how a run against an
 * already-running server works.
 */
export function providedRedisUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.NEXT_SSE_TEST_REDIS_URL?.trim() || undefined;
}

/**
 * Start one throwaway server for the run. Testcontainers publishes the port on a random host
 * port, so concurrent runs never collide, and Ryuk removes the container even when the run is
 * killed before teardown.
 */
export async function startRedisContainer(image: string): Promise<RunningRedis> {
  const container: StartedTestContainer = await new GenericContainer(image)
    .withExposedPorts(REDIS_PORT)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  return {
    url: `redis://${container.getHost()}:${String(container.getMappedPort(REDIS_PORT))}`,
    stop: async () => {
      await container.stop();
    },
  };
}
