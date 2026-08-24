import { describe, it } from "vitest";

import type { Retention, Transport } from "../transport/index.js";
import { contractCases } from "./transport-contract.cases.js";

export { contractCases } from "./transport-contract.cases.js";

/**
 * What a Transport can be asked to do beyond the interface itself, so that the obligations no
 * log can demonstrate on its own — an unreachable backend, a second Instance on the same log —
 * are verified where the backend supports them. Every hook is optional: the cases that need one
 * are skipped, visibly, when it is absent, and never silently dropped.
 */
export interface TransportBackend {
  /**
   * Cut one Transport off from the backend and let it back in. The outage is that Transport's
   * alone, never the whole backend's: a `peer` keeps publishing throughout, and the log goes on
   * advancing and trimming past the position the cut Transport would resume from, which is the
   * only way a gap can be staged at all. A backend that can only be stopped wholesale — a paused
   * container — cannot supply this hook honestly; route each Transport through a path that can
   * be cut on its own instead.
   */
  outage?: {
    begin: (transport: Transport) => Promise<void>;
    end: (transport: Transport) => Promise<void>;
  };
  /**
   * Another Transport on the same log as the one given, standing for a second Instance of the
   * App. It is closed by the suite with the Transport it was made from.
   */
  peer?: (transport: Transport) => Transport | Promise<Transport>;
}

/** What `transportContract` needs to exercise a Transport. */
export interface TransportContractOptions {
  /**
   * A Transport on a log of its own, empty, honouring the Retention it is given (ADR-0006).
   * The suite calls this once or twice per case and closes what it was handed; a factory that
   * shares one backend must isolate each call — a fresh Prefix per call, for the Redis
   * Transport — since a case assumes nothing is in the log but what it published.
   */
  create: (options: { retention: Retention }) => Transport | Promise<Transport>;
  backend?: TransportBackend;
}

/** A capability a case cannot run without. */
export type Capability = "outage" | "peer";

/** What a case is handed: the Transports it may open, and the backend hooks it declared. */
export interface ContractContext {
  /** A Transport on a log of its own, closed for the case when it ends. */
  transport: (retention?: Retention) => Promise<Transport>;
  /** Another Transport on the same log. Only a case declaring `peer` may call it. */
  peer: (transport: Transport) => Promise<Transport>;
  /** The outage a Transport sees. Only a case declaring `outage` may call it. */
  outage: {
    begin: (transport: Transport) => Promise<void>;
    end: (transport: Transport) => Promise<void>;
  };
}

/** One obligation of ADR-0005, as a name and the run that proves it. */
export interface ContractCase {
  name: string;
  /** What the backend must be able to do for this case to mean anything. */
  needs?: readonly Capability[];
  run: (context: ContractContext) => Promise<void>;
}

/**
 * How long one case is given. The generous bound is for the cases that wait on a subscription
 * healing itself across an outage, where the Transport's own reconnect delay is in play.
 */
const CASE_TIMEOUT_MS = 30_000;

/** The capability a case declares that this backend does not supply, if there is one. */
function missingCapability(
  contractCase: ContractCase,
  backend: TransportBackend | undefined,
): Capability | undefined {
  return contractCase.needs?.find((capability) => backend?.[capability] === undefined);
}

/**
 * Run one case against a Transport factory, opening the Transports it asks for and closing
 * every one of them — and ending any outage it left running — however it ends. Exported for
 * the suite's own meta-test, which runs the cases against toy Transports; a consumer runs them
 * through `transportContract`.
 */
export async function runContractCase(
  contractCase: ContractCase,
  options: TransportContractOptions,
): Promise<void> {
  const opened: Transport[] = [];
  const outaged = new Set<Transport>();

  const unsupported = (capability: Capability): never => {
    throw new Error(
      `The case "${contractCase.name}" used backend.${capability} without declaring it.`,
    );
  };

  const context: ContractContext = {
    transport: async (retention = {}) => {
      const transport = await options.create({ retention });
      opened.push(transport);

      return transport;
    },
    peer: async (transport) => {
      const make = options.backend?.peer ?? (() => unsupported("peer"));
      const peer = await make(transport);
      opened.push(peer);

      return peer;
    },
    outage: {
      begin: async (transport) => {
        const outage = options.backend?.outage ?? unsupported("outage");
        await outage.begin(transport);
        outaged.add(transport);
      },
      end: async (transport) => {
        const outage = options.backend?.outage ?? unsupported("outage");
        await outage.end(transport);
        outaged.delete(transport);
      },
    },
  };

  try {
    await contractCase.run(context);
  } finally {
    for (const transport of outaged) await options.backend?.outage?.end(transport);
    for (const transport of opened) await transport.close().catch(() => undefined);
  }
}

/**
 * The Vitest-bound contract suite every Transport owes (ADR-0005): call it inside your own
 * test file with a factory, and the whole log obligation is verified the way the shipped
 * Transports are — publish and its Cursor, paging strictly after with an honest `done` and an
 * honest `gone`, the live feed, close, and the error taxonomy.
 */
export function transportContract(options: TransportContractOptions): void {
  describe("the Transport contract", () => {
    for (const contractCase of contractCases) {
      const missing = missingCapability(contractCase, options.backend);

      if (missing !== undefined) {
        it.skip(`${contractCase.name} (needs backend.${missing})`, () => undefined);
        continue;
      }

      it(contractCase.name, async () => runContractCase(contractCase, options), CASE_TIMEOUT_MS);
    }
  });
}
