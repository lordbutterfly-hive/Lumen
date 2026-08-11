import { chromium } from '@playwright/test';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1485, height: 828 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0,90)));
await p.goto('http://127.0.0.1:3000/witnesses', { waitUntil: 'load', timeout: 250000 });
await p.waitForTimeout(15000);
console.log(JSON.stringify(await p.evaluate(() => ({
  bodyLen: document.body.innerText.length,
  svgs: document.querySelectorAll('svg').length,
  general: !!document.querySelector('[data-testid="witnesses-view-general"]'),
  params: !!document.querySelector('[data-testid="witnesses-view-params"]'),
  names: /gtg|blocktrades/i.test(document.body.innerText),
  showing: (document.body.innerText.match(/Showing \d+ of \d+/)||[null])[0]
}))), 'errors:', JSON.stringify([...new Set(errs)].slice(0,1)));
await b.close();
