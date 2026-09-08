import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1330, height: 1120 } });
await page.goto(`file://${process.argv[2]}`);
await page.waitForTimeout(400);
const rows = await page.$$eval('.phone .switch', (switches) => switches.map((sw) => {
  const pill = sw.getBoundingClientRect();
  const thumb = sw.querySelector('.thumb').getBoundingClientRect();
  const segs = [...sw.querySelectorAll('.seg span')].map((el) => el.getBoundingClientRect());
  const r = (n) => Math.round(n * 100) / 100;
  const on = sw.classList.contains('on');
  const thumbCentre = r(thumb.left + thumb.width / 2 - pill.left);
  return {
    state: on ? (sw.classList.contains('live') ? 'connected' : 'connecting') : 'off',
    thumbCentreX: thumbCentre,
    offLabelCentreX: r(segs[0].left + segs[0].width / 2 - pill.left),
    onLabelCentreX: r(segs[1].left + segs[1].width / 2 - pill.left),
    labelCentreY: r(segs[0].top + segs[0].height / 2 - pill.top),
    pillCentreY: r(pill.height / 2),
  };
}));
console.log(JSON.stringify(rows, null, 1));
await browser.close();
