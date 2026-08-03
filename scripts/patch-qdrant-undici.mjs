/**
 * Node 26's fetch rejects undici@6 Agent ("invalid onError method").
 * @qdrant/js-client-rest always attaches that Agent in Node — strip it unless
 * QDRANT_USE_UNDICI_AGENT=1.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const targets = [
  "node_modules/@qdrant/js-client-rest/dist/esm/api-client.js",
  "node_modules/@qdrant/js-client-rest/dist/cjs/api-client.js",
];

const marker = "Node 26+: bundled fetch rejects undici";

for (const rel of targets) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) continue;
  let text = fs.readFileSync(file, "utf8");
  if (text.includes(marker)) {
    console.log(`[patch-qdrant] already patched ${rel}`);
    continue;
  }

  const next = text.replace(
    /dispatcher:\s*typeof process !== 'undefined' &&\s*\/\/[^\n]*\s*process\.versions\?\.node\s*\?\s*createDispatcher\(connections\)\s*:\s*undefined,/,
    `// ${marker}
            ...(process.env.QDRANT_USE_UNDICI_AGENT === '1'
                ? {
                    dispatcher:
                        typeof process !== 'undefined' && process.versions?.node
                            ? createDispatcher(connections)
                            : undefined,
                }
                : {}),`
  );

  // CJS / minified-ish variant
  const next2 = next.replace(
    /dispatcher:\s*typeof process !== "undefined" &&\s*process\.versions\?\.node\s*\?\s*createDispatcher\(connections\)\s*:\s*void 0,/,
    `// ${marker}
            ...(process.env.QDRANT_USE_UNDICI_AGENT === "1"
                ? {
                    dispatcher:
                        typeof process !== "undefined" && process.versions?.node
                            ? createDispatcher(connections)
                            : void 0,
                }
                : {}),`
  );

  if (next2 === text) {
    console.warn(`[patch-qdrant] pattern not found in ${rel}`);
    continue;
  }
  fs.writeFileSync(file, next2);
  console.log(`[patch-qdrant] patched ${rel}`);
}
