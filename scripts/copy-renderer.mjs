// レンダラの静的アセット(html/css/js)を dist/renderer/ へコピーする。
// tscはこれらを扱わないため別途コピーが必要。
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "renderer");
const dest = join(root, "dist", "renderer");

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`copied renderer assets → ${dest}`);
