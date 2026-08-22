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

const resultReplacement = `async function extractResult(page){
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('table tbody tr')].filter(tr => tr.querySelectorAll('td').length >= 3);
    const text = (document.body.innerText || '').toLowerCase();
    return rows.length > 0 || text.includes('nessun risultato') || text.includes('nessuna revisione');
  }, { timeout: 12000 }).catch(() => {});
  await sleep(300);

  const bodyText = await page.evaluate(() => document.body.innerText.replace(/\\u00a0/g, ' '));
  const tableRows = await page.evaluate(() => [...document.querySelectorAll('table tbody tr')]
    .map(tr => [...tr.querySelectorAll('td')].map(td => (td.innerText || '').replace(/\\s+/g, ' ').trim()))
    .filter(cells => cells.length >= 3));

  const revisions = [];
  for (const cells of tableRows) {
    const dt = normalizeDate(cells[0]);
    const km = numberFromToken(cells[2]);
    if (!dt || km == null) continue;
    const outcomeText = String(cells[1] || '').trim();
    let outcome = outcomeText ? outcomeText.toLowerCase() : 'registrata';
    if (/regolare|positivo|ok/i.test(outcomeText)) outcome = 'regolare';
    else if (/ripetere|sospes|negativ/i.test(outcomeText)) outcome = 'da verificare';
    const plateAtRevision = String(cells[3] || '').trim().toUpperCase();
    if (!revisions.some(r => r.isoDate === dt.iso && r.km === km)) {
      revisions.push({
        date: dt.display,
        isoDate: dt.iso,
        km,
        outcome,
        plateAtRevision,
        sourceLine: cells.join(' | ')
      });
    }
  }

  let parsed = revisions.sort((a,b) => a.isoDate.localeCompare(b.isoDate));
  if (!parsed.length) {
    const tableLines = tableRows.map(cells => cells.join(' | '));
    parsed = parseRevisionLines(tableLines);
    if (!parsed.length) {
      const lines = bodyText.split(/\\n+/).map(s => s.trim()).filter(Boolean);
      parsed = parseRevisionLines(lines);
    }
  }

  console.log('RESULT_ROWS', JSON.stringify(tableRows));
  console.log('RESULT_PARSED', JSON.stringify(parsed));
  console.log('RESULT_TEXT', bodyText.slice(0, 8000));
  return { revisions: parsed, rawText: bodyText.slice(0,18000) };
}`;

const resultRe = /async function extractResult\(page\)\{[\s\S]*?\n\}\nfunction looksCaptchaRejected/;
if (!resultRe.test(code)) {
  throw new Error('Impossibile applicare il fix risultati: funzione non trovata.');
}
code = code.replace(resultRe, resultReplacement + '\nfunction looksCaptchaRejected');

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
