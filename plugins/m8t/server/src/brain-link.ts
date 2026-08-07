/**
 * This file originally shipped BrainLink + parseBrainLink. They were later
 * promoted to @m8t-stack/api-contract so the CLI + gateway + plugin all share one type.
 * This file is kept as a thin re-export for back-compat with any internal
 * imports inside the plugin server.
 */
export type { BrainLink } from "@m8t-stack/api-contract";
export {
  parseBrainLink,
  isAppMode,
  isInContainer,
  IN_CONTAINER_CREDENTIAL_REF,
  serializeBrainLink,
} from "@m8t-stack/api-contract";
