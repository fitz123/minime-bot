/** Stable public adapter API. Importing it starts no worker or provider session. */
export {
  resolveBehavioralFoundation,
  renderBehavioralFoundation,
  resolveFoundationSkillPaths,
  foundationSkillArgs,
  BehavioralFoundationError,
  MINIME_BEHAVIORAL_FOUNDATION_ROOT_ENV,
} from "./behavioral-foundation.js";
export type { BehavioralFoundationManifest, ResolvedBehavioralFoundation } from "./behavioral-foundation.js";
export { assemblePiContext, assemblePiSubagentFoundation, piContextResourceArgs } from "./pi-context-assembler.js";
export type { PiContextArtifacts, PiContextAssemblyOptions, PiContextManifest } from "./pi-context-assembler.js";
