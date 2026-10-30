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
      const sections = text.split(/^#{2,} /m);
      const cliSection = sections.find((part) => part.startsWith("CLI, MCP, and adapters\n"));
      expect(cliSection, "missing CLI section").toBeDefined();
      for (const binary of Object.keys(pkg.bin)) {
        expect(cliSection, `missing binary ${binary}`).toContain(`npx ${binary} `);
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
        const names = checker.getExportsOfModule(module).map((symbol) => symbol.name);
        for (const name of names) {
          expect(section, `${specifier} missing ${name}`).toContain(`\`${name}\``);
        }
        // Backticked identifiers in the prose are the export inventory. Ignore examples.
        const prose = section!.replace(/```[\s\S]*?```/g, "");
        const documented = [...prose.matchAll(/`([A-Za-z_$][\w$]*)`/g)].map((match) => match[1]!);
        const members: Record<string, string[]> = {
          [`${pkg.name}/client`]: ["fetch", "retries", "code", "status"],
          [`${pkg.name}/worker`]: ["store", "blobs", "auth"],
          [`${pkg.name}/ui`]: ["update", "unmount", "getToken", "onOpenItem"],
        };
        for (const name of documented) {
          if (members[specifier]?.includes(name)) continue;
          expect(names, `${specifier} documents non-export ${name}`).toContain(name);
        }
      }
    });
  }
});
