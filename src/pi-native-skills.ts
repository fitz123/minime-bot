/** Pinned Pi 1.5.0 parser entrypoints, without its CLI/SDK barrel side effects. */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Pi from "@earendil-works/pi-coding-agent";

// Resolve from our installed dependency, so source and packed installs use the
// same package-owned dist layout even when node_modules is hoisted.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
export const { loadSkills, loadSkillsFromDir } = await import(
  pathToFileURL(join(packageRoot, "dist/core/skills.js")).href
) as Pick<typeof Pi, "loadSkills" | "loadSkillsFromDir">;
export const { parseFrontmatter } = await import(
  pathToFileURL(join(packageRoot, "dist/utils/frontmatter.js")).href
) as Pick<typeof Pi, "parseFrontmatter">;
export type { LoadSkillsResult } from "@earendil-works/pi-coding-agent";
