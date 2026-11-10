// Headless screenshots: node scripts/shots.mjs [baseUrl]
import puppeteer from 'puppeteer-core';
const base = process.argv[2] ?? 'http://localhost:4173/hanoi-flow-lab/';
const shots = [
  ['normal', '?scenario=morning&controller=ai&speed=8', 25000, null],
  ['heatmap', '?scenario=evening&controller=ai&speed=8&layer=heat', 25000, null],
  ['night', '?scenario=normal&controller=ai&speed=8&night=1', 25000, 'zoom'],
  ['split', '?scenario=morning&controller=ai&speed=8&view=split', 25000, null],
  ['comparison', '?scenario=morning&speed=1&compare=1', 1500, 'compare'],
  ['inspect', '?scenario=morning&controller=ai&speed=8', 20000, 'inspect'],
];
const only = process.argv[3];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1600,900'] });
for (const [name, q, wait, action] of shots) {
  if (only && only !== name) continue;
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on('console', m => { if (m.type() === 'error') console.log('console error:', m.text()); });
  page.on('pageerror', e => console.log('pageerror:', e.message));
  await page.goto(base + q, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, wait));
  if (action === 'zoom') {
    const c = await page.$('.pixi canvas'); const b = await c.boundingBox();
    const sp = await page.evaluate(() => window.__pickSignal?.());
    await page.mouse.move(sp ? sp.x : b.x + b.width * 0.52, sp ? sp.y : b.y + b.height * 0.45);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel({ deltaY: -300 }); await new Promise(r => setTimeout(r, 100)); }
    await new Promise(r => setTimeout(r, 3000));
  }
  if (action === 'inspect') {
    const c = await page.$('.pixi canvas'); const b = await c.boundingBox();
    const sp = await page.evaluate(() => window.__pickSignal?.());
    await page.mouse.move(sp ? sp.x : b.x + b.width * 0.55, sp ? sp.y : b.y + b.height * 0.5);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel({ deltaY: -300 }); await new Promise(r => setTimeout(r, 100)); }
    const pos = await page.evaluate(() => window.__pickSignal?.());
    if (pos) await page.mouse.click(pos.x, pos.y); else await page.mouse.click(b.x + b.width * 0.55, b.y + b.height * 0.5);
    await new Promise(r => setTimeout(r, 2500));
  }
  if (action === 'compare') {
    await page.evaluate(() => { const s = [...document.querySelectorAll('.modal select')][1]; if (s) { s.value = '20'; s.dispatchEvent(new Event('change', { bubbles: true })); } });
    await page.evaluate(() => [...document.querySelectorAll('.modal button')].find(b => b.textContent.includes('Chạy 3'))?.click());
    await page.waitForSelector('.cmp', { timeout: 600000 });
    await new Promise(r => setTimeout(r, 800));
    const h = await page.evaluate(() => document.querySelector('.modal-body').scrollHeight + 80);
    await page.setViewport({ width: 1600, height: Math.max(900, h) });
    await new Promise(r => setTimeout(r, 500));
    const txt = await page.evaluate(() => document.querySelector('.cmp').innerText);
    console.log(txt);
  }
  const perf = await page.evaluate(() => document.querySelector('.perf')?.textContent);
  console.log(name, perf);
  await page.screenshot({ path: `shots/${name}.png` });
  await page.close();
}
await browser.close();
