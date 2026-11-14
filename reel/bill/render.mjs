// Renders the made-up water bill to a PDF and a PNG of each page: `node reel/bill/render.mjs`.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 });
await page.goto("file://" + path.join(here, "water-bill.html"));
await page.pdf({ path: path.join(here, "water-bill.pdf"), format: "A4", printBackground: true, preferCSSPageSize: true });
// One picture per page: water-bill-page1.png, water-bill-page2.png, ...
const pages = await page.locator(".page").all();
for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(here, `water-bill-page${i + 1}.png`) });
await browser.close();
console.log(`wrote water-bill.pdf and ${pages.length} page pictures`);
