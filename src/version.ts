import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

// The tool name in reports (and SARIF, where GitHub code scanning keys alerts on it) stays
// unscoped, so moving the npm package to @mintwork/ doesn't split existing alert history.
export const TOOL = { name: pkg.name.replace(/^@[^/]+\//, ""), version: pkg.version };
