/**
 * Downloads face-api.js model weights into public/models (self-hosted).
 * Run: node scripts/fetch-models.mjs
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "public", "models");

const BASE =
  "https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights";

const FILES = [
  "tiny_face_detector_model-weights_manifest.json",
  "tiny_face_detector_model-shard1",
  "face_landmark_68_model-weights_manifest.json",
  "face_landmark_68_model-shard1"
];

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  for (const name of FILES) {
    const dest = path.join(OUT, name);
    const url = `${BASE}/${name}`;
    process.stdout.write(`Fetching ${name}... `);
    try {
      await download(url, dest);
      console.log("ok");
    } catch (e) {
      console.error("failed:", e.message);
      process.exitCode = 1;
      return;
    }
  }
  console.log("Face models ready in public/models/");
}

main();
