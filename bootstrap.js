const fs = require('fs');
const path = require('path');
const Module = require('module');

const filename = path.join(__dirname, 'server.js');
let code = fs.readFileSync(filename, 'utf8');

const captchaReplacement = `async function captchaScreenshot(page) {
  await sleep(500);
  const src = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')];
    const img = imgs.find(el => {
      const blob = [el.getAttribute('alt'), el.getAttribute('aria-label'), el.getAttribute('title'), el.id,
        typeof el.className === 'string' ? el.className : ''].join(' ').toLowerCase();
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
  if (handle) return await handle.screenshot({ type: 'png' });
  throw new Error('CAPTCHA presente ma non acquisibile.');
}`;

const captchaRe = /async function captchaScreenshot\(page\) \{[\s\S]*?\n\}\n\nfunction dataUrl\(buf\)/;
if (!captchaRe.test(code)) throw new Error('Impossibile applicare il fix CAPTCHA.');
code = code.replace(captchaRe, captchaReplacement + '\n\nfunction dataUrl(buf)');

const vehicleReplacement = `async function setVehicleType(page) {
  await sleep(300);

  const prep = await page.evaluate(() => {
    const visible = el => {
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
    const describe = el => ({
      value: el.value || '',
      placeholder: el.placeholder || '',
      role: el.getAttribute('role') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      type: el.type || '',
      outer: el.outerHTML.slice(0,500)
    });
    const candidates = inputs.filter(el => {
      const blob = [el.id, el.name, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('role')]
        .join(' ').toLowerCase();
      return !blob.includes('targa') && !blob.includes('captcha');
    });
    const target = candidates.find(el => (el.getAttribute('role') || '').toLowerCase() === 'combobox') || candidates[0] || null;
    if (!target) return { ok:false, inputs:inputs.map(describe) };
    target.focus();
    target.click();
    return { ok:true, already:/autoveicolo/i.test(target.value || ''), target:describe(target), inputs:inputs.map(describe) };
  });

  console.log('VEHICLE_TYPE_PREP', JSON.stringify(prep));
  if (!prep.ok) throw new Error('Campo Tipologia veicolo non trovato sul Portale.');

  if (!prep.already) {
    await page.keyboard.down('Control').catch(()=>{});
    await page.keyboard.press('A').catch(()=>{});
    await page.keyboard.up('Control').catch(()=>{});
    await page.keyboard.press('Backspace').catch(()=>{});
    await page.keyboard.type('AUTOVEICOLO', { delay:35 }).catch(()=>{});
    await sleep(500);

    const optionState = await page.evaluate(() => {
      const visible = el => {
        const s=getComputedStyle(el), r=el.getBoundingClientRect();
        return s.display!=='none' && s.visibility!=='hidden' && r.width>0 && r.height>0;
      };
      const els = Array.from(document.querySelectorAll('[role="option"],li,div,span,p'))
        .filter(el => visible(el) && (el.textContent || '').trim().toUpperCase() === 'AUTOVEICOLO');
      if (!els.length) return { found:false };
      const el = els.sort((a,b) => {
        const ar=a.getBoundingClientRect(), br=b.getBoundingClientRect();
        return (ar.width*ar.height) - (br.width*br.height);
      })[0];
      const r=el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left+5,clientY:r.top+5}));
      el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:r.left+5,clientY:r.top+5}));
      el.click();
      return { found:true, text:(el.textContent||'').trim(), role:el.getAttribute('role')||'', outer:el.outerHTML.slice(0,500) };
    });
    console.log('VEHICLE_TYPE_OPTION', JSON.stringify(optionState));

    if (!optionState.found) {
      await page.keyboard.press('ArrowDown').catch(()=>{});
      await page.keyboard.press('Enter').catch(()=>{});
    }
    await sleep(600);
  }

  const state = await page.evaluate(() => {
    const visible = el => {
      const s=getComputedStyle(el), r=el.getBoundingClientRect();
      return s.display!=='none' && s.visibility!=='hidden' && r.width>0 && r.height>0;
    };
    const inputs=Array.from(document.querySelectorAll('input')).filter(visible);
    return inputs.map(el=>({
      value:el.value||'', placeholder:el.placeholder||'', role:el.getAttribute('role')||'',
      ariaLabel:el.getAttribute('aria-label')||''
    }));
  });
  console.log('VEHICLE_TYPE_STATE', JSON.stringify(state));
}`;

const vehicleRe = /async function setVehicleType\(page\) \{[\s\S]*?\n\}\n\nasync function findCaptchaInput/;
if (!vehicleRe.test(code)) throw new Error('Impossibile applicare il fix Tipologia veicolo.');
code = code.replace(vehicleRe, vehicleReplacement + '\n\nasync function findCaptchaInput');

const resultReplacement = `async function extractResult(page){
  await sleep(250);
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
    revisions.push({ date:dt.display, isoDate:dt.iso, km, outcome, plateAtRevision, sourceLine:cells.join(' | ') });
  }
  const parsed = revisions.sort((a,b) => a.isoDate.localeCompare(b.isoDate));
  console.log('RESULT_ROWS', JSON.stringify(tableRows));
  console.log('RESULT_PARSED', JSON.stringify(parsed));
  console.log('RESULT_TEXT', bodyText.slice(0,8000));
  return { revisions:parsed, rawText:bodyText.slice(0,18000) };
}`;
const resultRe = /async function extractResult\(page\)\{[\s\S]*?\n\}\nfunction looksCaptchaRejected/;
if (!resultRe.test(code)) throw new Error('Impossibile applicare il fix risultati.');
code = code.replace(resultRe, resultReplacement + '\nfunction looksCaptchaRejected');

const solveReplacement = `app.post('/api/check/solve', async (req,res) => {
  const id=String(req.body?.sessionId||''), codeValue=String(req.body?.captcha||'').trim(), s=sessions.get(id);
  if(!s) return res.status(410).json({error:'Sessione scaduta. Inserisci di nuovo la targa.'});
  if(codeValue.length<3) return res.status(400).json({error:'Inserisci il CAPTCHA.'});
  try {
    const input=await findCaptchaInput(s.page);
    if(!input) throw new Error('Campo CAPTCHA non trovato sul Portale.');
    await input.click({clickCount:3});
    await input.type(codeValue,{delay:25});

    const validated=await clickButton(s.page,/^valida$|valida captcha/i);
    if(!validated) throw new Error('Pulsante Valida non trovato sul Portale.');
    await s.page.waitForNetworkIdle({idleTime:500,timeout:8000}).catch(()=>{});
    await sleep(700);

    let text=await s.page.evaluate(()=>document.body.innerText);
    if(looksCaptchaRejected(text)) return res.json({captchaRejected:true});

    const searchState=await s.page.evaluate(() => {
      const buttons=[...document.querySelectorAll('button,input[type=button],input[type=submit],a')];
      const b=buttons.find(el => /avvia ricerca/i.test((el.innerText||el.value||'').trim()));
      if(!b) return {found:false,enabled:false};
      const cs=getComputedStyle(b);
      const disabled=!!b.disabled || b.getAttribute('aria-disabled')==='true' || cs.pointerEvents==='none';
      return {found:true,enabled:!disabled,disabled:!!b.disabled,ariaDisabled:b.getAttribute('aria-disabled')||'',className:typeof b.className==='string'?b.className:''};
    });
    console.log('POST_CAPTCHA_SEARCH_STATE', JSON.stringify(searchState));
    if(!searchState.found) throw new Error('Pulsante Avvia Ricerca non trovato.');
    if(!searchState.enabled) throw new Error('Il Portale non ha abilitato la ricerca dopo il CAPTCHA. Verifica il CAPTCHA e riprova.');

    const searched=await clickButton(s.page,/avvia ricerca/i);
    if(!searched) throw new Error('Impossibile avviare la ricerca sul Portale.');
    await s.page.waitForNetworkIdle({idleTime:600,timeout:10000}).catch(()=>{});

    const loaded=await s.page.waitForFunction(() => {
      const rows=[...document.querySelectorAll('table tbody tr')].filter(tr=>tr.querySelectorAll('td').length>=3);
      const txt=document.body.innerText||'';
      return rows.length>0 || /Tipologia veicolo\s*:/i.test(txt) || /Targa ricercata\s*:/i.test(txt) || /nessun risultato|nessuna revisione/i.test(txt);
    }, {timeout:10000}).then(()=>true).catch(()=>false);

    if(!loaded) {
      const stillForm=await s.page.evaluate(()=>document.body.innerText.slice(0,3000));
      console.log('SEARCH_NOT_LOADED', stillForm);
      throw new Error('Il Portale non ha restituito la pagina dei risultati. La ricerca non è stata eseguita.');
    }

    const result=await extractResult(s.page);
    const plate=s.plate;
    await closeSession(id);
    res.json({plate,...result});
  } catch(e) {
    console.error('SOLVE_ERROR', e && (e.stack || e.message || e));
    res.status(502).json({error:'La verifica non è stata completata: '+e.message});
  }
});`;
const solveRe = /app\.post\('\/api\/check\/solve',[\s\S]*?\n\}\);\n\napp\.delete/;
if (!solveRe.test(code)) throw new Error('Impossibile applicare il fix flusso ricerca.');
code = code.replace(solveRe, solveReplacement + '\n\napp.delete');

code = code.replace(
  "await sleep(1800); await setVehicleType(page); await fillPlate(page,plate); await sleep(500);",
  "await sleep(1800); await setVehicleType(page); await fillPlate(page,plate); await sleep(700); console.log('FORM_SNAPSHOT', JSON.stringify(await visibleFormSnapshot(page)));"
);
code = code.replace(
  "}catch(e){if(context)try{await context.close()}catch{};res.status(502).json({error:'Non riesco ad aprire il controllo revisioni del Portale: '+e.message});}",
  "}catch(e){console.error('START_ERROR', e && (e.stack || e.message || e)); if(context)try{await context.close()}catch{};res.status(502).json({error:'Non riesco ad aprire il controllo revisioni del Portale: '+e.message});}"
);

const runtime = new Module(filename, module);
runtime.filename = filename;
runtime.paths = module.paths;
runtime._compile(code, filename);
