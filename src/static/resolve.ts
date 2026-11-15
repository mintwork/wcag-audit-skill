/**
 * Finds the definition of a component imported from another file of the project, so rules can see
 * what an imported <Field> or <Input> renders. Resolves relative imports, tsconfig / jsconfig `paths`
 * aliases (`@/components/…`) and workspace packages (`@acme/ui/input`). Bare npm packages are not
 * resolved (their source isn't part of the scan). Everything is cached and failures return undefined.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ElementNode, ParsedDocument } from "./ast.js";
import { parseJsx } from "./parse-jsx.js";

export interface ComponentDef {
  /** Absolute path of the defining file. */
  file: string;
  /** Local name in the defining file. */
  name: string;
  trees: ElementNode[];
  doc: ParsedDocument;
}

export interface ComponentResolver {
  /** Finds the component that `imp` (an import of `fromFile`, an absolute path) refers to. */
  resolve(fromFile: string, imp: { source: string; imported: string }): ComponentDef | undefined;
  /** Parsed JSX documents by absolute path, shared with the scan so no file is parsed twice. */
  docs: Map<string, ParsedDocument | null>;
}

const EXTS = [".tsx", ".ts", ".jsx", ".js", ".mjs"];
const MAX_BYTES = 1_000_000;

interface PathsConfig {
  dir: string;
  baseUrl: string;
  /** [prefix, suffix, targets, wildcard] */
  paths: Array<[prefix: string, suffix: string, targets: string[], wildcard: boolean]>;
}

/** tsconfig.json allows comments and trailing commas. */
function readJsonc(file: string): unknown {
  try {
    const text = readFileSync(file, "utf8")
      .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str: string | undefined) => str ?? "")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createResolver(root: string): ComponentResolver {
  const docs = new Map<string, ParsedDocument | null>();
  const pathsByDir = new Map<string, PathsConfig | null>();
  let workspaces: Map<string, string> | undefined;

  const load = (file: string): ParsedDocument | undefined => {
    if (docs.has(file)) return docs.get(file) ?? undefined;
    let doc: ParsedDocument | null = null;
    try {
      const st = statSync(file);
      if (st.size <= MAX_BYTES) doc = parseJsx(file, readFileSync(file, "utf8"));
    } catch {
      doc = null;
    }
    docs.set(file, doc);
    return doc ?? undefined;
  };

  const asFile = (base: string): string | undefined => {
    for (const cand of [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => path.join(base, "index" + e))]) {
      if (EXTS.includes(path.extname(cand)) && statSync(cand, { throwIfNoEntry: false })?.isFile()) return cand;
    }
    // import "./x.js" written for a .ts / .tsx source (NodeNext style).
    if (/\.(m?js|jsx)$/.test(base)) return asFile(base.replace(/\.(m?js|jsx)$/, ""));
    return undefined;
  };

  const pathsFor = (fromFile: string): PathsConfig | undefined => {
    let dir = path.dirname(fromFile);
    const seen: string[] = [];
    while (dir.startsWith(root) || dir === root) {
      if (pathsByDir.has(dir)) {
        const hit = pathsByDir.get(dir) ?? undefined;
        for (const d of seen) pathsByDir.set(d, hit ?? null);
        return hit;
      }
      seen.push(dir);
      for (const name of ["tsconfig.json", "jsconfig.json"]) {
        const cfgFile = path.join(dir, name);
        if (!existsSync(cfgFile)) continue;
        const cfg = configWithPaths(cfgFile, 0);
        if (cfg) {
          for (const d of seen) pathsByDir.set(d, cfg);
          return cfg;
        }
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    for (const d of seen) pathsByDir.set(d, null);
    return undefined;
  };

  /** compilerOptions.paths from a tsconfig, following relative `extends` (2 levels). */
  const configWithPaths = (cfgFile: string, depth: number): PathsConfig | undefined => {
    const cfg = readJsonc(cfgFile) as { extends?: string; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } } | undefined;
    if (!cfg) return undefined;
    const co = cfg.compilerOptions ?? {};
    const dir = path.dirname(cfgFile);
    if (co.paths) {
      const baseUrl = path.resolve(dir, co.baseUrl ?? ".");
      const paths = Object.entries(co.paths).map(([k, v]): [string, string, string[], boolean] => {
        const star = k.indexOf("*");
        return star === -1 ? [k, "", v, false] : [k.slice(0, star), k.slice(star + 1), v, true];
      });
      return { dir, baseUrl, paths };
    }
    if (depth < 2 && typeof cfg.extends === "string" && cfg.extends.startsWith(".")) {
      const parent = path.resolve(dir, cfg.extends.endsWith(".json") ? cfg.extends : cfg.extends + ".json");
      return existsSync(parent) ? configWithPaths(parent, depth + 1) : undefined;
    }
    return undefined;
  };

  /** Workspace packages: package.json "name" → directory, found within 4 levels of the root. */
  const workspacePackages = (): Map<string, string> => {
    if (workspaces) return workspaces;
    workspaces = new Map();
    const walk = (dir: string, depth: number) => {
      if (depth > 4) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (depth > 0 && entries.some((e) => e.isFile() && e.name === "package.json")) {
        const pkg = readJsonc(path.join(dir, "package.json")) as { name?: string } | undefined;
        if (pkg?.name && !workspaces!.has(pkg.name)) workspaces!.set(pkg.name, dir);
      }
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist" && e.name !== "build") walk(path.join(dir, e.name), depth + 1);
    };
    walk(root, 0);
    return workspaces;
  };

  const modules = new Map<string, string | undefined>();
  /** Cached per (directory, specifier): most files of a directory import the same modules. */
  const resolveModule = (fromFile: string, spec: string): string | undefined => {
    const key = (spec.startsWith(".") ? path.dirname(fromFile) : "") + "\0" + spec + "\0" + (spec.startsWith(".") ? "" : path.dirname(fromFile));
    if (modules.has(key)) return modules.get(key);
    const hit = resolveUncached(fromFile, spec);
    modules.set(key, hit);
    return hit;
  };

  const resolveUncached = (fromFile: string, spec: string): string | undefined => {
    if (spec.startsWith(".")) return asFile(path.resolve(path.dirname(fromFile), spec));
    const cfg = pathsFor(fromFile);
    if (cfg) {
      for (const [prefix, suffix, targets, wildcard] of cfg.paths) {
        if (wildcard ? !spec.startsWith(prefix) || !spec.endsWith(suffix) || spec.length < prefix.length + suffix.length : spec !== prefix) continue;
        if (wildcard && !prefix && !suffix) continue; // "*": every bare package
        const middle = spec.slice(prefix.length, spec.length - suffix.length);
        for (const t of targets) {
          const hit = asFile(path.resolve(cfg.baseUrl, t.split("*").join(middle)));
          if (hit) return hit;
        }
      }
    }
    // Workspace package (monorepo): @acme/ui/primitives/input → packages/ui/(src/)primitives/input
    const m = /^((?:@[^/]+\/)?[^/]+)(?:\/(.*))?$/.exec(spec);
    if (!m) return undefined;
    const dir = workspacePackages().get(m[1]!);
    if (!dir) return undefined;
    const sub = m[2] ?? "";
    for (const base of [path.join(dir, sub), path.join(dir, "src", sub)]) {
      const hit = sub || base !== dir ? asFile(base) : asFile(path.join(dir, "index")) ?? asFile(path.join(dir, "src", "index"));
      if (hit) return hit;
    }
    return undefined;
  };

  const exportsCache = new Map<string, ComponentDef | undefined>();
  /** The component exported as `exported` from `file`, following re-exports (bounded depth). */
  const findExport = (file: string, exported: string, depth: number): ComponentDef | undefined => {
    const key = file + "\0" + exported;
    if (exportsCache.has(key)) return exportsCache.get(key);
    const hit = findExportUncached(file, exported, depth);
    exportsCache.set(key, hit);
    return hit;
  };

  const findExportUncached = (file: string, exported: string, depth: number): ComponentDef | undefined => {
    if (depth > 4) return undefined;
    const doc = load(file);
    const mod = doc?.modules;
    if (!doc || !mod) return undefined;
    const local = mod.exports.get(exported);
    if (local) {
      const trees = doc.components?.get(local);
      if (trees?.length) return { file, name: local, trees, doc };
      // export { Input } where Input was itself imported: follow the import.
      const imp = mod.imports.get(local);
      if (imp && imp.imported !== "*") {
        const target = resolveModule(file, imp.source);
        return target ? findExport(target, imp.imported, depth + 1) : undefined;
      }
      return undefined;
    }
    for (const r of mod.reexports) {
      if (r.exported !== exported || r.imported === "*") continue;
      const target = resolveModule(file, r.source);
      if (target) return findExport(target, r.imported, depth + 1);
    }
    for (const src of mod.exportAll) {
      const target = resolveModule(file, src);
      const hit = target && findExport(target, exported, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  };

  return {
    docs,
    resolve(fromFile, imp) {
      if (imp.imported === "*") return undefined;
      const target = resolveModule(fromFile, imp.source);
      if (!target || target === fromFile) return undefined;
      return findExport(target, imp.imported, 0);
    },
  };
}
