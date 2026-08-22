const fs = require('fs');
const Module = require('module');

const originalJsLoader = Module._extensions['.js'];
Module._extensions['.js'] = function patchedLoader(mod, filename) {
  if (!filename.endsWith('/v4.js') && !filename.endsWith('\\v4.js')) {
    return originalJsLoader(mod, filename);
  }

  let code = fs.readFileSync(filename, 'utf8');

  const oldCaptchaPenalty = "if(/logo|facebook|minister|portale/.test(blob))n-=500;";
  const newCaptchaPenalty = "if(/logo|facebook|minister/.test([el.alt,el.title,el.id,typeof el.className==='string'?el.className:''].join(' ').toLowerCase()))n-=500;";
  if (!code.includes(oldCaptchaPenalty)) throw new Error('AutoVerifica v4 preload: CAPTCHA patch target not found');
  code = code.replace(oldCaptchaPenalty, newCaptchaPenalty);

  const oldVehicleSelector = "const candidates = [...document.querySelectorAll('button,a,label,li,input[type=button],input[type=submit],input[type=radio]')]";
  const newVehicleSelector = "const candidates = [...document.querySelectorAll('button,a,label,li,input[type=button],input[type=submit],input[type=radio],input[type=image]')]";
  if (!code.includes(oldVehicleSelector)) throw new Error('AutoVerifica v4 preload: vehicle selector patch target not found');
  code = code.replace(oldVehicleSelector, newVehicleSelector);

  const oldVehicleText = ".map(el => ({ el, text:(el.innerText||el.value||el.title||el.getAttribute('aria-label')||'').trim() }))";
  const newVehicleText = ".map(el => ({ el, text:[el.innerText,el.value,el.title,el.getAttribute('aria-label'),el.getAttribute('alt'),el.getAttribute('src'),el.getAttribute('name'),el.id,el.getAttribute('formaction')].filter(Boolean).join(' ').trim() }))";
  if (!code.includes(oldVehicleText)) throw new Error('AutoVerifica v4 preload: vehicle metadata patch target not found');
  code = code.replace(oldVehicleText, newVehicleText);

  // RCA starts with a "Veicolo" button and only then exposes the Autoveicolo selector.
  const oldVehicleFilter = ".filter(x => /^autoveicolo$/i.test(x.text) || /\\bautoveicolo\\b/i.test(x.text));";
  const newVehicleFilter = ".filter(x => /^autoveicolo$/i.test(x.text) || /\\bautoveicolo\\b/i.test(x.text) || (x.el.tagName==='INPUT' && (((x.el.getAttribute('name')||'').toLowerCase()==='veicolo') || /^veicolo$/i.test(x.el.value||''))));";
  if (!code.includes(oldVehicleFilter)) throw new Error('AutoVerifica v4 preload: vehicle filter patch target not found');
  code = code.replace(oldVehicleFilter, newVehicleFilter);

  const oldNoVehicle = "if (!candidates.length) return { ok:false };";
  const newNoVehicle = `if (!candidates.length) {
      const graphical=[...document.querySelectorAll('input[type=image]')].filter(visible);
      if(graphical.length===2){
        graphical[0].setAttribute('data-av-autoveicolo','1');
        return {ok:true,mode:'click',fallback:'first-of-two-image-choices'};
      }
      return { ok:false };
    }`;
  if (!code.includes(oldNoVehicle)) throw new Error('AutoVerifica v4 preload: vehicle fallback patch target not found');
  code = code.replace(oldNoVehicle, newNoVehicle);

  // RCA official flow: Veicolo -> Autoveicolo -> targa/CAPTCHA.
  const oldPrepareVehicle = "if(module==='revisions'||module==='environment'||module==='rca')await chooseAutoveicolo(s.page).catch(()=>false);";
  const newPrepareVehicle = `if(module==='revisions'||module==='environment')await chooseAutoveicolo(s.page).catch(()=>false);
  if(module==='rca'){
    await chooseAutoveicolo(s.page).catch(()=>false);
    await sleep(350);
    await chooseAutoveicolo(s.page).catch(()=>false);
    await sleep(250);
  }`;
  if (!code.includes(oldPrepareVehicle)) throw new Error('AutoVerifica v4 preload: RCA two-stage prepare target not found');
  code = code.replace(oldPrepareVehicle, newPrepareVehicle);

  // Retry only when the Portale actually reports a bad CAPTCHA.
  const oldCaptchaRejected = "function captchaRejected(text){return /captcha|caratteri/i.test(text||'')&&/errat|non valid|sbagli|riprova|non corret/i.test(text||'');}";
  const newCaptchaRejected = `function captchaRejected(text){
  const t=String(text||'').replace(/\\s+/g,' ');
  return /(?:captcha|caratteri)[^.!?\\n]{0,160}(?:errat|non\\s+valid|sbagli|riprova)/i.test(t)
    || /(?:errat|non\\s+valid|sbagli|riprova)[^.!?\\n]{0,160}(?:captcha|caratteri)/i.test(t);
}`;
  if (!code.includes(oldCaptchaRejected)) throw new Error('AutoVerifica v4 preload: CAPTCHA rejected patch target not found');
  code = code.replace(oldCaptchaRejected, newCaptchaRejected);

  const oldSolveTail = "if(s.stage==='environment')s.data.environment=await extractEnvironment(s.page);\n  return {captchaRejected:false};";
  const newSolveTail = "if(s.stage==='environment')s.data.environment=await extractEnvironment(s.page);\n  if(s.stage==='novice')s.data.novice=await extractNovice(s.page);\n  return {captchaRejected:false};";
  if (!code.includes(oldSolveTail)) throw new Error('AutoVerifica v4 preload: novice patch target not found');
  code = code.replace(oldSolveTail, newSolveTail);

  const staticLine = "app.use(express.static(path.join(__dirname, 'public-v4'), { extensions: ['html'] }));";
  const cleanRoot = `app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public-v4', 'progress-v2.html'));
});
${staticLine}`;
  if (!code.includes(staticLine)) throw new Error('AutoVerifica v4 preload: static route patch target not found');
  code = code.replace(staticLine, cleanRoot);

  mod._compile(code, filename);
};
