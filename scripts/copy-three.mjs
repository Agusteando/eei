import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = resolve("node_modules/three/build/three.module.js");
const target = resolve("public/vendor/three.module.js");

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`Copied ${source} -> ${target}`);
