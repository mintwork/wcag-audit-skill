/**
 * Form controls rendered by components: design-system inputs (MUI <TextField>, Mantine <TextInput>,
 * antd <Input>, …) whose label comes from a prop or a wrapper, and thin project wrappers (shadcn-style
 * <Input {...props} />) that render a native control defined in another file.
 */
import type { ElementNode } from "./ast.js";
import { ancestor, has, isDynamic, sv, walk } from "./helpers.js";
import type { RuleContext } from "./rules.js";

/** Components that associate a label with the control inside them (or might: we can't see them). */
export const LABEL_WRAPPER = /label|field|form\.?item|form\.?control|form\.?group|input\.?wrapper/i;

interface DesignSystem {
  lib: string;
  pkg: RegExp;
  /** Input components, by imported name (members like Input.Password included). */
  names: RegExp;
  /** Props that name the control (lowercase, as normalized). */
  labelProps: string[];
  fix: string;
}

const COMMON = ["aria-label", "aria-labelledby", "id"];

const DESIGN_SYSTEMS: DesignSystem[] = [
  {
    lib: "MUI",
    pkg: /^(@mui\/material|@mui\/joy|@material-ui\/core)(\/|$)/,
    names: /^(TextField|Input|InputBase|OutlinedInput|FilledInput)$/,
    labelProps: [...COMMON, "label", "inputprops", "slotprops", "inputlabelprops"],
    fix: 'Add label="…" (visible label), or inputProps={{ "aria-label": "…" }} / slotProps={{ htmlInput: { "aria-label": "…" } }} when there is no room for one.',
  },
  {
    lib: "Mantine",
    pkg: /^@mantine\/(core|dates)(\/|$)/,
    names: /^(TextInput|PasswordInput|NumberInput|Textarea|Select|MultiSelect|Autocomplete|NativeSelect|JsonInput|TagsInput|ColorInput|FileInput|DateInput|DatePickerInput|TimeInput)$/,
    labelProps: [...COMMON, "label"],
    fix: 'Add label="…", or aria-label="…" when there is no visible label.',
  },
  {
    lib: "Chakra UI",
    pkg: /^@chakra-ui\/(react|input|select|textarea)(\/|$)/,
    names: /^(Input|Textarea|Select)$/,
    labelProps: COMMON,
    fix: 'Wrap it in <Field.Root> / <FormControl> with a <Field.Label> / <FormLabel>, or add aria-label="…".',
  },
  {
    lib: "Ant Design",
    pkg: /^antd(\/|$)/,
    names: /^(Input|Input\.Password|Input\.TextArea|Input\.Search|InputNumber|TextArea|Select|AutoComplete|Mentions)$/,
    labelProps: COMMON,
    fix: 'Wrap it in <Form.Item label="…" name="…"> (which links the label), or add aria-label="…".',
  },
  {
    lib: "React Aria",
    pkg: /^react-aria-components(\/|$)/,
    names: /^(TextField|SearchField|NumberField|Select|ComboBox|DateField|TimeField|DatePicker)$/,
    labelProps: ["aria-label", "aria-labelledby"],
    fix: 'Add a <Label> inside it, or aria-label="…".',
  },
  {
    lib: "HeroUI",
    pkg: /^@(heroui|nextui-org)\/(react|input|select|autocomplete)(\/|$)/,
    names: /^(Input|Textarea|Select|Autocomplete)$/,
    labelProps: [...COMMON, "label"],
    fix: 'Add label="…", or aria-label="…" when there is no visible label.',
  },
  {
    lib: "React Bootstrap",
    pkg: /^react-bootstrap(\/|$)/,
    names: /^(Form\.Control|FormControl|Form\.Select|FormSelect)$/,
    labelProps: COMMON,
    fix: 'Wrap it in <Form.Group controlId="…"> with a <Form.Label>, or add aria-label="…".',
  },
  {
    lib: "Fluent UI",
    pkg: /^@fluentui\/react-components(\/|$)/,
    names: /^(Input|Textarea|Combobox|Dropdown|SpinButton)$/,
    labelProps: COMMON,
    fix: 'Wrap it in <Field label="…">, or add aria-label="…".',
  },
  {
    lib: "Headless UI",
    pkg: /^@headlessui\/react(\/|$)/,
    names: /^(Input|Textarea|Select)$/,
    labelProps: COMMON,
    fix: 'Wrap it in <Field> with a <Label>, or add aria-label="…".',
  },
];

export interface DesignSystemInput {
  lib: string;
  pkg: string;
  name: string;
  labelProps: string[];
  fix: string;
}

/** <TextField> imported from @mui/material, <Input.Password> from antd, … */
export function designSystemInput(ctx: RuleContext, el: ElementNode): DesignSystemInput | undefined {
  if (!el.isComponent) return undefined;
  const [base, ...rest] = el.tag.split(".");
  const imp = ctx.doc.modules?.imports.get(base!);
  if (!imp || imp.imported === "*") return undefined;
  // import TextField from "@mui/material/TextField": the default export's name is the subpath.
  const sub = imp.source.split("/").pop()!;
  const own = imp.imported !== "default" ? imp.imported : /^[A-Z]/.test(sub) ? sub : base!;
  const name = [own, ...rest].join(".");
  const ds = DESIGN_SYSTEMS.find((d) => d.pkg.test(imp.source) && d.names.test(name));
  return ds && { lib: ds.lib, pkg: imp.source, name, labelProps: ds.labelProps, fix: ds.fix };
}

/** True if the design-system input gets a name from a prop, a spread, a <Label> child or a wrapper. */
export function designSystemInputLabelled(ctx: RuleContext, el: ElementNode, ds: DesignSystemInput): boolean {
  if (el.hasSpread) return true;
  for (const p of ds.labelProps) {
    const a = el.attrs.get(p);
    if (!a) continue;
    if (p === "id") {
      if (a.dynamic || ctx.hasDynamicLabelTarget || (a.value && ctx.labelTargets.has(a.value))) return true;
      continue;
    }
    if (a.dynamic || (a.value ?? "").trim()) return true;
  }
  if (["hidden", "submit", "button", "reset", "image"].includes((sv(el, "type") ?? "").toLowerCase()) || isDynamic(el, "type")) return true;
  if (sv(el, "aria-hidden") === "true" || has(el, "hidden")) return true;
  // React Aria: <TextField><Label>Email</Label><Input /></TextField>.
  if ([...walk(el)].some((d) => d.isComponent && /(^|\.)Label$/.test(d.tag))) return true;
  return ancestor(el, (p) => p.tag === "label" || (p.isComponent && LABEL_WRAPPER.test(p.tag))) !== undefined;
}

const THIN_CONTROL_NAME = /Input|Textarea|TextArea|Select|Field$|Control$|Search|Combobox|Picker$/;

export interface ThinControl {
  tag: "input" | "select" | "textarea";
  /** Static type on the wrapped <input>, used when the call site sets none. */
  type?: string;
  /** File that defines the wrapper (undefined: this file). */
  file: string | undefined;
}

/**
 * A project component that only forwards its props to one native control, e.g. shadcn's
 * `const Input = (props) => <input className={cn(...)} {...props} />`. Anything that could supply a label
 * inside the component (a <label>, a label-ish component, aria-label / id on the control) disqualifies it.
 */
export function thinControl(ctx: RuleContext, el: ElementNode): ThinControl | undefined {
  if (!el.isComponent || el.tag.includes(".") || !ctx.resolveComponent) return undefined;
  // Only components named like a control are looked up (resolving every component would be slow).
  if (!THIN_CONTROL_NAME.test(el.tag)) return undefined;
  if (designSystemInput(ctx, el)) return undefined;
  const def = ctx.resolveComponent(el);
  if (!def) return undefined;
  const all = def.trees.flatMap((t) => [t, ...walk(t)]);
  const controls = all.filter((e) => e.tag === "input" || e.tag === "select" || e.tag === "textarea");
  if (controls.length !== 1) return undefined;
  const c = controls[0]!;
  // The control must receive the caller's props: {...props} / {...rest}, not {...getInputProps()}.
  if (!c.spreads?.some((s) => /^[A-Za-z_$][\w$]*$/.test(s.trim()))) return undefined;
  if (all.some((e) => e.tag === "label" || e.tag === "slot" || (e.isComponent && /label|field|form|tooltip/i.test(e.tag)))) return undefined;
  // Any rendered text ({label}, {description}, a hint) may be the label; so may createElement("label").
  if (all.some((e) => e.children.some((ch) => ch.type === "text"))) return undefined;
  if (/createElement\(|["'`]label["'`]/.test(def.doc.source)) return undefined;
  if (["aria-label", "aria-labelledby", "title", "id"].some((a) => has(c, a))) return undefined;
  return { tag: c.tag as ThinControl["tag"], type: sv(c, "type"), file: def.file };
}
