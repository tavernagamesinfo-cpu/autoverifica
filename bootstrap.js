const fs = require('fs');
const path = require('path');
const Module = require('module');

const filename = path.join(__dirname, 'server.js');
let code = fs.readFileSync(filename, 'utf8');

const replacement = `async function captchaScreenshot(page) {
  await sleep(900);

  const input = await findCaptchaInput(page);
  if (!input) throw new Error('Campo CAPTCHA non trovato sul Portale.');
  const inputBox = await input.boundingBox();
  if (!inputBox) throw new Error('Il campo CAPTCHA non è visibile sul Portale.');

  const candidates = await page.$$('img,canvas,svg');
  const ranked = [];

  for (const h of candidates) {
    const m = await h.evaluate(el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const blob = [
        el.id,
        typeof el.className === 'string' ? el.className : '',
        el.getAttribute('alt'),
        el.getAttribute('aria-label'),
        el.getAttribute('src'),
        el.getAttribute('title')
      ].join(' ').toLowerCase();
      return {
        visible: s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0,
        x: r.x, y: r.y, w: r.width, h: r.height,
        bottom: r.bottom,
        blob
      };
    }).catch(() => null);

    if (!m || !m.visible) continue;
    if (m.w < 70 || m.w > 700 || m.h < 20 || m.h > 240) continue;

    const explicitCaptcha = /captcha|codice|security|challenge/.test(m.blob);
    const obviousBrand = /logo|brand|header|portale|automobilista/.test(m.blob);
    const aboveInput = m.bottom <= inputBox.y + 35 && m.bottom >= inputBox.y - 500;
    const horizontalDistance = Math.abs((m.x + m.w / 2) - (inputBox.x + inputBox.width / 2));

    if (obviousBrand && !explicitCaptcha) continue;
    if (!explicitCaptcha && !aboveInput) continue;

    const verticalDistance = Math.max(0, inputBox.y - m.bottom);
    const score = (explicitCaptcha ? -10000 : 0) + verticalDistance + horizontalDistance * 0.15;
    ranked.push({ h, score, m });
  }

  ranked.sort((a, b) => a.score - b.score);
  if (ranked.length) {
    try {
      console.log('CAPTCHA_ELEMENT', JSON.stringify(ranked[0].m));
      return await ranked[0].h.screenshot({ type: 'png' });
    } catch {}
  }

  // Fallback: fotografia esclusivamente la zona immediatamente sopra il campo
  // CAPTCHA. In questo modo non selezioniamo più il logo del sito.
  const vp = page.viewport() || { width: 900, height: 920 };
  const x = Math.max(0, Math.min(inputBox.x - 100, vp.width - 420));
  const width = Math.min(vp.width - x, Math.max(420, inputBox.width + 200));
  const y = Math.max(0, inputBox.y - 300);
  const height = Math.max(80, Math.min(280, inputBox.y - y - 8));
  console.log('CAPTCHA_FALLBACK_CLIP', JSON.stringify({ x, y, width, height, inputBox }));
  return page.screenshot({ type: 'png', clip: { x, y, width, height } });
}`;

const re = /async function captchaScreenshot\(page\) \{[\s\S]*?\n\}\n\nfunction dataUrl\(buf\)/;
if (!re.test(code)) {
  throw new Error('Impossibile applicare il fix CAPTCHA: funzione non trovata.');
}
code = code.replace(re, replacement + '\n\nfunction dataUrl(buf)');

code = code.replace(
  "await sleep(1800); await setVehicleType(page); await fillPlate(page,plate); await sleep(500);",
  "await sleep(1800); await setVehicleType(page); await fillPlate(page,plate); await sleep(500); console.log('FORM_SNAPSHOT', JSON.stringify(await visibleFormSnapshot(page)));"
);

const runtime = new Module(filename, module);
runtime.filename = filename;
runtime.paths = module.paths;
runtime._compile(code, filename);
