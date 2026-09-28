import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import type { AcpSessionRuntimeLocator } from "./session-control-owner.js";
import type { AcpSessionReadInput } from "./session-meta-keys.js";
import type { AcpSessionSourceReadInput } from "./session-meta-write.types.js";

/** Declarative target constraints are rechecked inside the owning worker transaction. */
export type AcpSessionControlConstraint = AcpSessionSourceReadInput & {
  sharedSource: { path: string; identity: DatabasePathIdentity };
  ownerKey: string | undefined;
  runtimeLocator?: AcpSessionRuntimeLocator;
  read: Omit<AcpSessionReadInput, "entry">;
};
