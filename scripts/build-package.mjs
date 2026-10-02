// Builds one library package for publishing: run from the package's folder
// (its "build" script). Clears dist/, compiles src/ with tsconfig.build.json
// (JavaScript, .d.ts files, and their maps), then rewrites the relative
// ".ts" and ".tsx" import paths left in the .d.ts files to ".js". tsc
// rewrites them in the JavaScript (rewriteRelativeImportExtensions) but not
// in declarations, and an app's TypeScript would then look for .ts files
// the package does not ship.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dist = "dist";
rmSync(dist, { recursive: true, force: true });
execFileSync("tsc", ["-p", "tsconfig.build.json"], { stdio: "inherit", shell: process.platform === "win32" });

/** Relative specifiers in import, export, and import() forms, ending in .ts or .tsx. */
const RELATIVE_TS = /((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+?)\.tsx?(["'])/g;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith(".d.ts")) {
      const text = readFileSync(path, "utf8");
      const fixed = text.replace(RELATIVE_TS, "$1$2.js$3");
      if (fixed !== text) writeFileSync(path, fixed);
    }
  }
}
walk(dist);
