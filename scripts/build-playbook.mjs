#!/usr/bin/env node
/**
 * Generate src/playbook.generated.ts from the skill's reference files.
 *
 * The skill under skills/geolink is the single source of truth. The MCP server
 * serves the same text as resources so a client with no filesystem reads
 * exactly what a client with one reads. Generating rather than duplicating is
 * what makes that guarantee hold: there is no second copy to forget.
 *
 * Run by `npm run build`. Committed output, so a consumer installing from npm
 * or from a clone needs no extra step.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const refs = join(root, "skills", "geolink", "references");

const SOURCES = [
  { constant: "SKILL_OVERVIEW", file: join(root, "skills", "geolink", "SKILL.md"), strip: true },
  { constant: "PLAYBOOK_COVERAGE", file: join(refs, "coverage.md"), strip: false },
  { constant: "PLAYBOOK_RECIPES", file: join(refs, "recipes.md"), strip: false },
  { constant: "PLAYBOOK_TRIPWIRES", file: join(refs, "tripwires.md"), strip: false },
  { constant: "PLAYBOOK_COST", file: join(refs, "cost.md"), strip: false },
];

function stripFrontmatter(text) {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  return end === -1 ? text : text.slice(end + 4).replace(/^\n+/, "");
}

function escapeForTemplate(text) {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

const parts = [
  "/* eslint-disable */",
  "/**",
  " * GENERATED FILE - do not edit.",
  " *",
  " * Source of truth: skills/geolink/. Regenerate with `npm run build`",
  " * (or `node scripts/build-playbook.mjs`). Editing here is lost on the next",
  " * build and, worse, silently diverges the protocol copy from the file copy.",
  " */",
  "",
];

for (const source of SOURCES) {
  const raw = readFileSync(source.file, "utf8");
  const body = source.strip ? stripFrontmatter(raw) : raw;
  parts.push(`export const ${source.constant} = \`${escapeForTemplate(body)}\`;`);
  parts.push("");
}

const out = join(root, "src", "playbook.generated.ts");
writeFileSync(out, parts.join("\n"));
console.log(`playbook.generated.ts written from ${SOURCES.length} source files`);
