/**
 * Reading the wire the way a client does, for the tests that go through the real handler: one
 * SSE block at a time, in the order they were written, off a `Response` body.
 *
 * It lives beside the handler rather than in a test file because two suites read the same wire
 * — the handler's own unit tests and the integration scenarios that drive whole Connections —
 * and a second parser would be a second opinion on what a block is. The `.testkit.` in the name
 * is what keeps it out of the tarball: the package's build config excludes the pattern, the way
 * it excludes tests.
 */

/** One SSE block, as a client parses it: the fields it carried, by name. */
export interface Frame {
  id?: string;
  event?: string;
  data?: string;
  retry?: string;
}

/** Reads SSE blocks off a response body, one at a time, in the order they were written. */
export interface Frames {
  /** The next block, waiting for it if the stream has not written it yet. */
  next: () => Promise<Frame>;
  /** End the Connection, the way a client going away does. */
  cancel: () => Promise<void>;
}

export function framesOf(response: Response): Frames {
  const reader = (response.body ?? new ReadableStream<Uint8Array>()).getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  return {
    async next(): Promise<Frame> {
      for (;;) {
        const end = buffered.indexOf("\n\n");
        if (end !== -1) {
          const block = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);

          return parse(block);
        }

        const { done, value } = await reader.read();
        if (done) throw new Error("the stream ended before the next block");
        buffered += decoder.decode(value);
      }
    },
    cancel: () => reader.cancel(),
  };
}

function parse(block: string): Frame {
  const frame: Frame = {};
  for (const line of block.split("\n")) {
    const [name, value] = [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)];
    if (name === "id" || name === "event" || name === "data" || name === "retry") {
      frame[name] = value;
    }
  }

  return frame;
}
