// Mark the CJS output tree as CommonJS so Node doesn't apply the package's
// top-level "type": "module" to it.
import { writeFileSync } from "node:fs";
writeFileSync("dist/cjs/package.json", JSON.stringify({ type: "commonjs" }) + "\n");
