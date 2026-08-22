const express = require('express');
const crypto = require('crypto');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const PORTAL = 'https://www.ilportaledellautomobilista.it/web/portale-automobilista/verifica-revisioni-effettuate-x2345nmnmll';
const sessions = new Map();
let browserPromise = null;

app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanPlate = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote']
    }).catch(err => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { await s.context.close(); } catch {}
}

async function pageSnapshot(page) {
  return page.evaluate(() => {
    const visible = el => {
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const info = el => ({
      tag: el.tagName.toLowerCase(), id: el.id || '', name: el.getAttribute('name') || '',
      type: el.getAttribute('type') || '', value: 'value' in el ? String(el.value || '').slice(0,80) : '',
      placeholder: el.getAttribute('placeholder') || '', alt: el.getAttribute('alt') || '',
      title: el.getAttribute('title') || '', text: (el.innerText || el.value || '').trim().slice(0,120),
      src: el.tagName === 'IMG' ? (el.getAttribute('src') || '').slice(0,140) : ''
    });
    return {
      url: location.href,
      controls: [...document.querySelectorAll('select,input,button,img')].filter(visible).map(info),
      text: (document.body.innerText || '').slice(0,3000)
    };
  });
}

async function selectVehicle(page) {
  const result = await page.evaluate(() => {
    const visible = el => { const s=getComputedStyle(el),r=el.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0; };
    const selects = [...document.querySelectorAll('select')].filter(visible);
    for (const s of selects) {
      const opt = [...s.options].find(o => /autoveicolo/i.test(o.textContent || ''));
      if (opt) {
        s.value = opt.value;
        s.dispatchEvent(new Event('input', {bubbles:true}));
        s.dispatchEvent(new Event('change', {bubbles:true}));
        return {ok:true, method:'select', value:opt.value, text:opt.textContent};
      }
    }
    return {ok:false};
  });
  if (!result.ok) throw new Error('Campo Tipo veicolo non trovato nella pagina ufficiale.');
  console.log('LEGACY_VEHICLE', JSON.stringify(result));
}

async function fillInput(page, kind, value) {
  const result = await page.evaluate(({kind,value}) => {
    const visible = el => { const s=getComputedStyle(el),r=el.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0; };
    const inputs = [...document.querySelectorAll('input')].filter(visible).filter(el => !['hidden','submit','button','image','reset'].includes((el.type||'').toLowerCase()));
    function blob(el) {
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const parent = el.parentElement ? el.parentElement.innerText : '';
      return [el.id,el.name,el.placeholder,el.getAttribute('aria-label'),label?.innerText,parent].join(' ').toLowerCase();
    }
    function score(el) {
      const b=blob(el); let n=0;
      if (kind==='plate') { if(/targa/.test(b)) n+=200; if(/captcha/.test(b)) n-=300; }
      if (kind==='captcha') { if(/captcha|caratteri|identificare/.test(b)) n+=200; if(/targa/.test(b)) n-=300; }
      if((el.type||'text').toLowerCase()==='text') n+=5;
      return n;
    }
    const ranked=inputs.map(el=>({el,n:score(el),b:blob(el)})).sort((a,b)=>b.n-a.n);
    const x=ranked[0]; if(!x || x.n<0) return {ok:false,candidates:ranked.map(r=>({n:r.n,b:r.b,value:r.el.value}))};
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
    if(setter) setter.call(x.el,value); else x.el.value=value;
    x.el.dispatchEvent(new Event('input',{bubbles:true}));
    x.el.dispatchEvent(new Event('change',{bubbles:true}));
    x.el.dispatchEvent(new Event('blur',{bubbles:true}));
    return {ok:true, score:x.n, blob:x.b, value:x.el.value};
  }, {kind,value});
  if(!result.ok) throw new Error(kind==='plate' ? 'Campo targa non trovato.' : 'Campo CAPTCHA non trovato.');
  console.log(kind==='plate'?'LEGACY_PLATE':'LEGACY_CAPTCHA_INPUT', JSON.stringify(result));
}

async function getCaptcha(page) {
  const data = await page.evaluate(() => {
    const visible = el => { const s=getComputedStyle(el),r=el.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0; };
    const imgs=[...document.querySelectorAll('img')].filter(visible);
    let img=imgs.find(el => /captcha|testo da identificare|caratteri/i.test([el.alt,el.title,el.id,el.className].join(' ')));
    if(!img) img=imgs.find(el => { const r=el.getBoundingClientRect(); return r.width>=80&&r.width<=500&&r.height>=20&&r.height<=180; });
    if(!img) return null;
    img.setAttribute('data-autoverifica-captcha','1');
    return {src:img.getAttribute('src')||img.src||'',alt:img.alt||'',title:img.title||''};
  });
  if(!data) throw new Error('Immagine CAPTCHA non trovata nella pagina ufficiale.');
  if(data.src.startsWith('data:image/')) {
    const m=data.src.match(/^data:image\/[^;]+;base64,(.+)$/); if(m) return Buffer.from(m[1],'base64');
  }
  const handle=await page.$('[data-autoverifica-captcha="1"]');
  if(!handle) throw new Error('CAPTCHA trovato ma non acquisibile.');
  console.log('LEGACY_CAPTCHA', JSON.stringify({alt:data.alt,title:data.title,src:data.src.slice(0,120)}));
  return handle.screenshot({type:'png'});
}

async function submitForm(page) {
  const marked = await page.evaluate(() => {
    const visible = el => { const s=getComputedStyle(el),r=el.getBoundingClientRect(); return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0; };
    const els=[...document.querySelectorAll('button,input[type=submit],input[type=button],input[type=image]')].filter(visible);
    const arr=els.map(el=>{
      const text=(el.innerText||el.value||el.alt||el.title||'').trim();
      let score=0; if(/verifica|cerca|ricerca|invia|conferma|submit/i.test(text)) score+=100; if(/svuota|reset|cambia/i.test(text)) score-=200;
      if((el.type||'').toLowerCase()==='submit') score+=20;
      return {el,text,score};
    }).sort((a,b)=>b.score-a.score);
    const x=arr[0]; if(!x || x.score<0) return {ok:false,buttons:arr.map(a=>({text:a.text,score:a.score}))};
    x.el.setAttribute('data-autoverifica-submit','1');
    return {ok:true,text:x.text,score:x.score,tag:x.el.tagName,type:x.el.type||''};
  });
  if(!marked.ok) throw new Error('Pulsante di ricerca non trovato nella pagina ufficiale.');
  console.log('LEGACY_SUBMIT', JSON.stringify(marked));
  const nav=page.waitForNavigation({waitUntil:'domcontentloaded',timeout:12000}).catch(()=>null);
  await page.click('[data-autoverifica-submit="1"]');
  await nav;
  await page.waitForNetworkIdle({idleTime:500,timeout:8000}).catch(()=>{});
  await sleep(700);
}

function normalizeDate(s){const m=String(s).match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/);if(!m)return null;const d=m[1].padStart(2,'0'),mo=m[2].padStart(2,'0'),y=m[3];return{display:`${d}/${mo}/${y}`,iso:`${y}-${mo}-${d}`};}
function num(s){const x=String(s||'').replace(/[^0-9]/g,'');if(!x)return null;const n=Number(x);return Number.isFinite(n)?n:null;}

async function extractResult(page){
  const data=await page.evaluate(()=>({
    text:(document.body.innerText||'').replace(/\u00a0/g,' ').slice(0,18000),
    tables:[...document.querySelectorAll('table')].map(t=>({
      headers:[...t.querySelectorAll('thead th, tr:first-child th')].map(x=>(x.innerText||'').replace(/\s+/g,' ').trim()),
      rows:[...t.querySelectorAll('tr')].map(tr=>[...tr.querySelectorAll('td')].map(td=>(td.innerText||'').replace(/\s+/g,' ').trim())).filter(r=>r.length)
    }))
  }));
  const out=[];
  for(const table of data.tables){
    const hs=table.headers.map(x=>x.toLowerCase());
    let di=hs.findIndex(x=>/data|revisione/.test(x));
    let ki=hs.findIndex(x=>/km|chilometr/.test(x));
    let oi=hs.findIndex(x=>/esito|risultato/.test(x));
    let pi=hs.findIndex(x=>/targa/.test(x));
    for(const cells of table.rows){
      let dt=di>=0?normalizeDate(cells[di]):null;
      if(!dt){const c=cells.find(x=>normalizeDate(x));dt=c?normalizeDate(c):null;}
      if(!dt)continue;
      let km=ki>=0?num(cells[ki]):null;
      if(km==null){
        const candidates=cells.map(num).filter(n=>n!=null&&n>=100&&n<2000000&&(n<1900||n>2100));
        km=candidates.length?candidates[candidates.length-1]:null;
      }
      if(km==null)continue;
      const outcome=oi>=0?(cells[oi]||'registrata'):(cells.find(x=>/regolare|positivo|ripetere|sospes|negativ/i.test(x))||'registrata');
      const plateAtRevision=pi>=0?(cells[pi]||''):'';
      if(!out.some(r=>r.isoDate===dt.iso&&r.km===km))out.push({date:dt.display,isoDate:dt.iso,km,outcome:String(outcome).toLowerCase(),plateAtRevision:String(plateAtRevision).toUpperCase(),sourceLine:cells.join(' | ')});
    }
  }
  if(!out.length){
    for(const line of data.text.split(/\n+/)){
      const dt=normalizeDate(line); if(!dt)continue;
      const m=line.match(/(?:km|chilometr[^0-9]*)\s*[:\-]?\s*([0-9][0-9.\s]{2,12})/i)||line.match(/([0-9][0-9.\s]{2,12})\s*(?:km|chilometr)/i);
      if(!m)continue;const km=num(m[1]);if(km==null)continue;
      out.push({date:dt.display,isoDate:dt.iso,km,outcome:/regolare|positivo/i.test(line)?'regolare':'registrata',sourceLine:line.trim()});
    }
  }
  out.sort((a,b)=>a.isoDate.localeCompare(b.isoDate));
  console.log('LEGACY_RESULT',JSON.stringify(out));
  console.log('LEGACY_RESULT_TEXT',data.text.slice(0,5000));
  return {revisions:out,rawText:data.text};
}

function captchaRejected(text){return /captcha|caratteri/i.test(text||'')&&/errat|non valid|sbagli|riprova/i.test(text||'');}
function dataUrl(buf){return 'data:image/png;base64,'+Buffer.from(buf).toString('base64');}

app.get('/api/health',(req,res)=>res.json({ok:true,service:'AutoVerifica',source:'official-legacy-revisions'}));
app.get('/api/browser-health',async(req,res)=>{try{const b=await getBrowser();res.json({ok:!!b.connected});}catch(e){res.status(500).json({ok:false,error:e.message});}});

app.get('/api/debug/source',async(req,res)=>{
  let context;
  try{const browser=await getBrowser();context=await browser.createBrowserContext();const page=await context.newPage();await page.setViewport({width:1200,height:1000});await page.goto(PORTAL,{waitUntil:'domcontentloaded',timeout:45000});await sleep(1800);res.json(await pageSnapshot(page));}
  catch(e){res.status(500).json({error:e.message});}
  finally{if(context)try{await context.close()}catch{}}
});

app.post('/api/check/start',async(req,res)=>{
  const plate=cleanPlate(req.body?.plate);if(plate.length<5)return res.status(400).json({error:'Targa non valida.'});
  let context;
  try{
    const browser=await getBrowser();context=await browser.createBrowserContext();const page=await context.newPage();
    await page.setViewport({width:1200,height:1000,deviceScaleFactor:1});
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36');
    await page.goto(PORTAL,{waitUntil:'domcontentloaded',timeout:45000});await sleep(1800);
    console.log('LEGACY_START_URL',page.url());
    await selectVehicle(page);await fillInput(page,'plate',plate);await sleep(300);
    console.log('LEGACY_FORM',JSON.stringify(await pageSnapshot(page)));
    const img=await getCaptcha(page);const id=crypto.randomUUID();sessions.set(id,{context,page,plate,created:Date.now()});
    res.json({sessionId:id,plate,captchaImage:dataUrl(img)});
  }catch(e){console.error('START_ERROR',e.stack||e);if(context)try{await context.close()}catch{};res.status(502).json({error:'Non riesco ad aprire il controllo revisioni del Portale: '+e.message});}
});

app.post('/api/check/solve',async(req,res)=>{
  const id=String(req.body?.sessionId||''),code=String(req.body?.captcha||'').trim(),s=sessions.get(id);
  if(!s)return res.status(410).json({error:'Sessione scaduta. Inserisci di nuovo la targa.'});
  if(code.length<3)return res.status(400).json({error:'Inserisci il CAPTCHA.'});
  try{
    await fillInput(s.page,'captcha',code);
    await submitForm(s.page);
    const snap=await pageSnapshot(s.page);console.log('LEGACY_AFTER_SUBMIT',JSON.stringify(snap));
    if(captchaRejected(snap.text))return res.json({captchaRejected:true});
    const result=await extractResult(s.page);
    const noResults=/nessuna revisione|nessun risultato|non risultano revisioni/i.test(result.rawText);
    if(!result.revisions.length&&!noResults)throw new Error('Il Portale non ha restituito uno storico revisioni interpretabile.');
    const plate=s.plate;await closeSession(id);res.json({plate,...result});
  }catch(e){console.error('SOLVE_ERROR',e.stack||e);res.status(502).json({error:'La verifica non è stata completata: '+e.message});}
});

app.delete('/api/check/session/:id',async(req,res)=>{await closeSession(req.params.id);res.json({ok:true});});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

setInterval(()=>{const now=Date.now();for(const [id,s] of sessions)if(now-s.created>5*60*1000)closeSession(id);},60000).unref();
app.listen(PORT,'0.0.0.0',()=>console.log(`AutoVerifica listening on ${PORT}`));
process.on('SIGTERM',async()=>{try{if(browserPromise)(await browserPromise).close()}catch{}finally{process.exit(0)}});
