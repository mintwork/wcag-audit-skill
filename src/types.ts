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

/** Best-effort source location of a runtime finding (`--source`). A hint: verify before editing. */
export interface SourceHint {
  file: string;
  line: number;
  /** The handles that matched, e.g. ['data-testid="pay"', 'text "Pay now"']. */
  via: string[];
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
  /** Runtime findings with --source: where the element probably comes from in the source. */
  sourceHint?: SourceHint;
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
}
