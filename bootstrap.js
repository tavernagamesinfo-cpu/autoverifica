const fs = require('fs');
const path = require('path');
const Module = require('module');

const filename = path.join(__dirname, 'server.js');
let code = fs.readFileSync(filename, 'utf8');

const replacement = `async function captchaScreenshot(page) {
  await sleep(500);

  const src = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')];
    const img = imgs.find(el => {
      const blob = [
        el.getAttribute('alt'),
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.id,
        typeof el.className === 'string' ? el.className : ''
      ].join(' ').toLowerCase();
      return blob.includes('captcha');
    });
    return img ? (img.getAttribute('src') || img.src || null) : null;
  });

  if (!src) throw new Error('Immagine CAPTCHA non trovata sul Portale.');

  if (src.startsWith('data:image/')) {
    const match = src.match(/^data:image\\/[^;]+;base64,(.+)$/);
    if (!match) throw new Error('Formato CAPTCHA non riconosciuto.');
    console.log('CAPTCHA_SOURCE data-url');
    return Buffer.from(match[1], 'base64');
  }

  const handle = await page.$('img[alt="captcha"]');
  if (handle) {
    console.log('CAPTCHA_SOURCE element-screenshot');
    return await handle.screenshot({ type: 'png' });
  }

  throw new Error('CAPTCHA presente ma non acquisibile.');
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

code = code.replace(
  "}catch(e){if(context)try{await context.close()}catch{};res.status(502).json({error:'Non riesco ad aprire il controllo revisioni del Portale: '+e.message});}",
  "}catch(e){console.error('START_ERROR', e && (e.stack || e.message || e)); if(context)try{await context.close()}catch{};res.status(502).json({error:'Non riesco ad aprire il controllo revisioni del Portale: '+e.message});}"
);

code = code.replace(
  "}catch(e){res.status(502).json({error:'La verifica non è stata completata: '+e.message});}",
  "}catch(e){console.error('SOLVE_ERROR', e && (e.stack || e.message || e));res.status(502).json({error:'La verifica non è stata completata: '+e.message});}"
);

const runtime = new Module(filename, module);
runtime.filename = filename;
runtime.paths = module.paths;
runtime._compile(code, filename);
