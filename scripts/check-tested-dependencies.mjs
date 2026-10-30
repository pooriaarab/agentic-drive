import { execFileSync } from "node:child_process";

const { dependencies } = JSON.parse(execFileSync("npm", ["ls", "--json", "--depth=0"], { encoding: "utf8" }));
for (const name of ["agentic-design", "agentic-identity"]) {
  const runtime = dependencies[name]?.version;
  const tested = dependencies[`${name}-tested`]?.version;
  if (!runtime || runtime !== tested) {
    throw new Error(`${name}: runtime version ${runtime} does not match tested version ${tested}`);
  }
  console.log(`${name}: ${runtime}`);
}
