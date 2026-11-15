/** Labels that come from components defined in other files, and design-system inputs. */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeSource, scanStatic } from "../src/static/analyze.js";

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wcag-xfile-"));
  for (const [name, src] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), src);
  }
  return dir;
}

const formLabels = async (dir: string, target = "src") =>
  (await scanStatic(target, { cwd: dir, rules: ["form-label"] })).findings.map((f) => `${f.location.file}:${f.location.line} ${f.confidence}`);

const SHADCN_INPUT = `import * as React from "react";
import { cn } from "@/lib/utils";
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn("h-9", className)} {...props} />;
}
export { Input };`;

describe("thin input wrappers defined in another file", () => {
  it("resolves tsconfig paths (with comments), relative imports and barrels, and checks the call site", async () => {
    const dir = await project({
      "tsconfig.json": `{\n  // comment\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] }, },\n}`,
      "src/components/ui/input.tsx": SHADCN_INPUT,
      "src/components/ui/label.tsx": `export function Label(props) { return <label data-slot="label" {...props} />; }`,
      "src/components/index.ts": `export * from "./ui/input";`,
      "src/app/page.tsx": `import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Input as SearchInput } from "../components";
export default function Page() {
  return (
    <form>
      <Input placeholder="Email" />
      <Input aria-label="Search" />
      <Label htmlFor="name">Name</Label>
      <Input id="name" />
      <Input type="hidden" name="csrf" />
      <label>Phone <Input type="tel" /></label>
      <SearchInput placeholder="Via a barrel file" />
      <Input {...field} />
    </form>
  );
}`,
    });
    expect(await formLabels(dir)).toEqual(["src/app/page.tsx:7 medium", "src/app/page.tsx:13 medium"]);
    const [f] = (await scanStatic("src", { cwd: dir, rules: ["form-label"] })).findings;
    expect(f!.message).toMatch(/^<Input> renders an <input> \(defined in src\/components\/ui\/input\.tsx\) and gets no label here\. Control relies on placeholder/);
  });

  it("resolves workspace packages in a monorepo", async () => {
    const dir = await project({
      "packages/ui/package.json": `{ "name": "@acme/ui" }`,
      "packages/ui/primitives/input.tsx": SHADCN_INPUT,
      "apps/web/src/Search.tsx": `import { Input } from "@acme/ui/primitives/input";\nexport const S = () => <Input placeholder="Search" />;`,
    });
    expect(await formLabels(dir, "apps")).toEqual(["apps/web/src/Search.tsx:2 medium"]);
  });

  it("does not treat components that may render a label as thin wrappers", async () => {
    const dir = await project({
      "src/TextField.tsx": `export function TextField({ label, ...props }) { return <div><label>{label}<input {...props} /></label></div>; }`,
      "src/Hinted.tsx": `export const Hinted = ({ hint, ...props }) => <div><input {...props} /><small>{hint}</small></div>;`,
      "src/Dynamic.tsx": `export const CheckboxField = ({ label, ...rest }) => React.createElement("label", null, label, <input {...rest} />);`,
      "src/Dropzone.tsx": `export const DropzoneInput = () => <div><input {...getInputProps()} /></div>;`,
      "src/Named.tsx": `export const NamedInput = (props) => <input aria-label="Amount" {...props} />;`,
      "src/page.tsx": `import { TextField } from "./TextField";
import { Hinted } from "./Hinted";
import { CheckboxField } from "./Dynamic";
import { DropzoneInput } from "./Dropzone";
import { NamedInput } from "./Named";
export const P = () => <><TextField label="Email" /><Hinted hint="x" /><CheckboxField label="ok" /><DropzoneInput /><NamedInput /></>;`,
    });
    expect(await formLabels(dir)).toEqual([]);
  });

  it("reports an imported <Field> wrapper whose <label> is not associated", async () => {
    const dir = await project({
      "src/Field.tsx": `export default function Field({ label, children }) {\n  return <div><label className="l">{label}</label>{children}</div>;\n}`,
      "src/GoodField.tsx": `export function GoodField({ label, children }) { return <label>{label}{children}</label>; }`,
      "src/form.tsx": `import Field from "./Field";\nimport { GoodField } from "./GoodField";\nexport const F = () => <>\n<Field label="Region"><input value={v} /></Field>\n<GoodField label="City"><input value={v} /></GoodField>\n</>;`,
    });
    const r = await scanStatic("src", { cwd: dir, rules: ["form-label"] });
    expect(r.findings.map((f) => [f.location.line, f.confidence])).toEqual([[4, "medium"]]);
    expect(r.findings[0]!.message).toMatch(/<Field> \(defined in src\/Field\.tsx\)/);
  });
});

describe("design-system inputs", () => {
  const run = (src: string) => analyzeSource("Form.tsx", src, { rules: ["form-label"] }).map((f) => f.evidence);

  it("reports MUI, antd, Mantine, Chakra inputs without a label prop or wrapper (medium)", () => {
    const src = `import { TextField } from "@mui/material";
import MuiInput from "@mui/material/Input";
import { Input, Form } from "antd";
import { TextInput } from "@mantine/core";
import { Input as ChakraInput, Field } from "@chakra-ui/react";
export const F = () => <>
  <TextField placeholder="Search" />
  <MuiInput />
  <Input.Password />
  <TextInput placeholder="Name" />
  <ChakraInput />
</>;`;
    const f = analyzeSource("Form.tsx", src, { rules: ["form-label"] });
    expect(f.map((x) => x.evidence)).toEqual(['<TextField placeholder="Search" />', "<MuiInput />", "<Input.Password />", '<TextInput placeholder="Name" />', "<ChakraInput />"]);
    expect(f.every((x) => x.confidence === "medium")).toBe(true);
    expect(f[0]!.message).toMatch(/\(@mui\/material\) has no label \(a placeholder is not a label\)/);
    expect(f[2]!.fix).toMatch(/Form\.Item/);
  });

  it("accepts label props, wrappers, spreads and <Label> children", () => {
    const src = `import { TextField } from "@mui/material";
import { Input, Form } from "antd";
import { TextInput } from "@mantine/core";
import { Input as ChakraInput, Field } from "@chakra-ui/react";
import { TextField as AriaTextField, Label, Input as AriaInput } from "react-aria-components";
export const F = () => <>
  <TextField label="Email" />
  <TextField inputProps={{ "aria-label": "Search" }} />
  <TextField {...params} />
  <Form.Item label="Password" name="pw"><Input.Password /></Form.Item>
  <TextInput label={t("name")} />
  <Field.Root><Field.Label>Name</Field.Label><ChakraInput /></Field.Root>
  <AriaTextField><Label>Email</Label><AriaInput /></AriaTextField>
  <label htmlFor="q">Query</label><Input id="q" />
  <Input type="hidden" />
</>;`;
    expect(run(src)).toEqual([]);
  });

  it("ignores same-named components from other packages", () => {
    expect(run(`import { TextField } from "./my-textfield";\nexport const F = () => <TextField />;`)).toEqual([]);
  });
});

describe("label components", () => {
  it("<Label htmlFor>, <FormLabel htmlFor> and <FieldLabel htmlFor> associate like <label for>", () => {
    for (const tag of ["Label", "FormLabel", "FieldLabel"]) {
      const src = `export const F = () => <><${tag} htmlFor="e">Email</${tag}><input id="e" /></>;`;
      expect(analyzeSource("F.tsx", src, { rules: ["form-label"] }), tag).toEqual([]);
    }
  });
});
