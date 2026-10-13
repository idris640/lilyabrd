// Builds the static storefront for Cloudflare Pages.
//
// Cloudflare Pages settings:
//   Build command:          node build.mjs
//   Build output directory: dist
//
// It copies the site into dist/ and downloads the product catalogue from
// Firestore ONCE per deploy, saving it as static files:
//   dist/catalog.json        list of products + one small thumbnail each
//   dist/media/<id>.json     full photo list of one product
//   dist/img/<hash>.<ext>    every photo as a real image file
// Visitors then load the catalogue from Cloudflare (no traffic limit)
// instead of from Firebase. If anything goes wrong while downloading, the
// site is still published without a catalogue and the storefront simply
// reads the products from Firebase like before, so a failed build can
// never take the store offline.

import { mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";

const PROJECT = "lilyabrand-13629";
const API_KEY = "AIzaSyALbiInt3_1Mz98tijCExLLCPeMJMQjbAw"; // public web key, same as in index.html
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const OUT = "dist";
const SITE_FILES = ["index.html", "admin.html"];

// Firestore REST returns typed values ({stringValue: "x"}); turn them into plain JSON.
export function decodeValue(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("referenceValue" in v) return v.referenceValue;
  if ("geoPointValue" in v) return v.geoPointValue;
  if ("bytesValue" in v) return v.bytesValue;
  return null;
}
export function decodeFields(fields) {
  const o = {};
  for (const [k, v] of Object.entries(fields || {})) o[k] = decodeValue(v);
  return o;
}

async function getJSON(url) {
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.split("?")[0]}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function listProducts() {
  const out = [];
  let token = "";
  do {
    const url = `${BASE}/products?pageSize=100&key=${API_KEY}${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
    const j = await getJSON(url);
    for (const d of (j && j.documents) || []) {
      out.push(Object.assign({ id: d.name.split("/").pop() }, decodeFields(d.fields)));
    }
    token = (j && j.nextPageToken) || "";
  } while (token);
  return out;
}

async function getMedia(id) {
  const j = await getJSON(`${BASE}/products/${encodeURIComponent(id)}/media/main?key=${API_KEY}`);
  return j ? decodeFields(j.fields) : {};
}

// data:image/jpeg;base64,... -> /img/<hash>.jpg written to dist. URLs are kept as-is.
const written = new Map();
const BUILT_AT = Date.now();
export async function imageToFile(src, outDir = OUT) {
  if (!src || typeof src !== "string") return "";
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(src);
  if (!m) return src;
  if (written.has(src)) return written.get(src);
  const ext = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[m[1].toLowerCase()] || "img";
  const buf = Buffer.from(m[2], "base64");
  const name = createHash("sha1").update(buf).digest("hex").slice(0, 16) + "." + ext;
  await writeFile(`${outDir}/img/${name}`, buf);
  const url = `/img/${name}`;
  written.set(src, url);
  return url;
}

export async function buildCatalog(products, mediaFor, outDir = OUT) {
  await mkdir(`${outDir}/img`, { recursive: true });
  await mkdir(`${outDir}/media`, { recursive: true });
  const catalog = [];
  for (const p of products) {
    const media = p.mediaSplit ? await mediaFor(p.id) : { images: p.images || [], imagesSecondary: p.imagesSecondary || [] };
    const images = [];
    for (const s of media.images || []) images.push(await imageToFile(s, outDir));
    const imagesSecondary = [];
    for (const s of media.imagesSecondary || []) imagesSecondary.push(await imageToFile(s, outDir));
    const thumb = (await imageToFile(p.thumb, outDir)) || images[0] || imagesSecondary[0] || "";
    const { images: _a, imagesSecondary: _b, thumb: _t, ...rest } = p;
    catalog.push(Object.assign(rest, { thumb, builtAt: BUILT_AT }));
    await writeFile(`${outDir}/media/${encodeURIComponent(p.id)}.json`, JSON.stringify({ images: images.filter(Boolean), imagesSecondary: imagesSecondary.filter(Boolean) }));
  }
  await writeFile(`${outDir}/catalog.json`, JSON.stringify(catalog));
  return catalog;
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  for (const f of SITE_FILES) await copyFile(f, `${OUT}/${f}`);
  try {
    const products = await listProducts();
    const catalog = await buildCatalog(products, getMedia);
    console.log(`Catalogue built: ${catalog.length} products, ${written.size} images.`);
  } catch (e) {
    // Publish the site anyway: without catalog.json the storefront reads Firebase directly.
    console.error("Could not build the static catalogue, publishing without it:", e.message || e);
    await rm(`${OUT}/catalog.json`, { force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
