// Browser render benchmark (headless Chrome, software GL via SwiftShader - real GPUs are much faster)
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'fs';
const base = process.argv[2] ?? 'http://localhost:4173/hanoi-flow-lab/';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const out = [];
for (const target of [1000, 3000, 5000, 10000]) {
  for (const q of ['', '&quality=low']) {
    const page = await browser.newPage(); await page.setViewport({ width: 1600, height: 900 });
    await page.goto(`${base}?scenario=extreme&controller=ai&speed=64&cap=${target}&demand=${Math.max(1, target / 1500)}${q}`, { waitUntil: 'networkidle0' });
    const t0 = Date.now(); let n = 0;
    while (Date.now() - t0 < 150000) { await new Promise(r => setTimeout(r, 2000)); const txt = await page.evaluate(() => document.querySelector('.perf')?.textContent ?? ''); n = +(txt.split(' xe')[0]); if (n >= target * 0.95) break; }
    await new Promise(r => setTimeout(r, 4000));
    const perf = await page.evaluate(() => document.querySelector('.perf')?.textContent);
    const r = { target, quality: q ? 'low' : 'normal', perf, reachedAfterS: Math.round((Date.now() - t0) / 1000) }; console.log(JSON.stringify(r)); out.push(r);
    await page.close();
  }
}
writeFileSync('results/browser_bench.json', JSON.stringify({ note: 'headless Chrome + SwiftShader (CPU rendering) on the build box; speed=Max', results: out }, null, 1));
await browser.close();
