export { scan, verifyReport, isUrl, filterConfidence, type ScanOptions, type VerifyResult } from "./scan.js";
export { scanStatic, analyzeSource, collectFiles, type StaticOptions } from "./static/analyze.js";
export { scanUrl, type RuntimeOptions } from "./runtime/scan-url.js";
export { rules } from "./static/rules.js";
export { formatText, formatJson, formatSarif } from "./report/index.js";
export { WCAG } from "./wcag.js";
export * from "./types.js";
export { addSourceHints, handlesFor } from "./runtime/source-hints.js";
