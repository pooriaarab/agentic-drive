import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  name: string;
  exports: Record<string, string | { types: string; import: string }>;
  bin: Record<string, string>;
};

// Read the build entries so a new export path cannot escape this check.
const config = ts.createSourceFile("tsup.config.ts", readFileSync(resolve(root, "tsup.config.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const entries = new Map<string, string>();
function visit(node: ts.Node): void {
  if (ts.isPropertyAssignment(node) && node.name.getText(config) === "entry" && ts.isObjectLiteralExpression(node.initializer)) {
    for (const prop of node.initializer.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.initializer)) entries.set(prop.name.getText(config).replaceAll('"', ""), prop.initializer.text);
    }
  }
  ts.forEachChild(node, visit);
}
visit(config);

const paths = Object.values(pkg.exports).filter((value): value is { types: string; import: string } => typeof value !== "string");
const sources = paths.map((value) => {
  const source = entries.get(basename(value.import, ".js"));
  if (!source) throw new Error(`No build entry for ${value.import}`);
  return resolve(root, source);
});
const program = ts.createProgram(sources, { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 });
const checker = program.getTypeChecker();

describe("public export documentation", () => {
  for (const doc of ["README.md", "llms.txt"]) {
    it(`names each package path and exported symbol in ${doc}`, () => {
      const text = readFileSync(resolve(root, doc), "utf8");
      const sections = text.split(/^### /m);
      for (const binary of Object.keys(pkg.bin)) {
        expect(text, `missing binary ${binary}`).toContain(`npx ${binary} `);
      }
      for (const [path, target] of Object.entries(pkg.exports)) {
        const specifier = path === "." ? pkg.name : `${pkg.name}/${path.slice(2)}`;
        const section = sections.find((part) => part.split("\n", 1)[0].includes(`\`${specifier}\``));
        expect(section, `missing section for ${specifier}`).toBeDefined();
        if (typeof target === "string") continue; // CSS has no named exports.
        const source = entries.get(basename(target.import, ".js"));
        if (!source) throw new Error(`No build entry for ${target.import}`);
        const file = program.getSourceFile(resolve(root, source));
        if (!file) throw new Error(`Missing source ${source}`);
        const module = checker.getSymbolAtLocation(file);
        if (!module) throw new Error(`Missing module ${source}`);
        for (const symbol of checker.getExportsOfModule(module)) {
          expect(section, `${specifier} missing ${symbol.name}`).toContain(`\`${symbol.name}\``);
        }
      }
    });
  }
});
