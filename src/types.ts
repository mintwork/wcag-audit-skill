export type Severity = "critical" | "serious" | "moderate" | "minor";

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  serious: 3,
  moderate: 2,
  minor: 1,
};

export type Confidence = "high" | "medium" | "low";

export type FindingSource = "static" | "runtime" | "keyboard";

export interface Location {
  /** Source file (relative to cwd) for static findings. */
  file?: string;
  line?: number;
  column?: number;
  /** URL for runtime findings. */
  url?: string;
  /** CSS selector for runtime findings. */
  selector?: string;
}

export interface Finding {
  /** Stable fingerprint: same issue at same place yields same id across runs. */
  id: string;
  ruleId: string;
  source: FindingSource;
  title: string;
  /** WCAG success criteria, e.g. ["1.1.1"]. */
  wcag: string[];
  /** WCAG conformance level of the strictest criterion: A, AA, AAA. */
  level: "A" | "AA" | "AAA";
  severity: Severity;
  confidence: Confidence;
  location: Location;
  /** The offending markup / snippet. */
  evidence: string;
  /** Why this is a problem, in plain words. */
  message: string;
  /** Concrete suggested fix. */
  fix: string;
  helpUrl?: string;
  /** Set by the verification phase. */
  verified?: boolean;
}

export interface ScanResult {
  tool: { name: string; version: string };
  target: string;
  kind: "static" | "runtime";
  startedAt: string;
  durationMs: number;
  filesScanned?: number;
  findings: Finding[];
  /** Findings dropped during verification (not reproducible). */
  discarded: number;
  /** Findings hidden because they are in the --baseline file. */
  baselined?: number;
}
