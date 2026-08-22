const fs = require('fs');
const Module = require('module');

const originalJsLoader = Module._extensions['.js'];
Module._extensions['.js'] = function patchedLoader(mod, filename) {
  if (!filename.endsWith('/v4.js') && !filename.endsWith('\\v4.js')) {
    return originalJsLoader(mod, filename);
  }

  let code = fs.readFileSync(filename, 'utf8');

  // The CAPTCHA src contains the portal domain/path; do not penalize it for the word "portale".
  const oldCaptchaPenalty = "if(/logo|facebook|minister|portale/.test(blob))n-=500;";
  const newCaptchaPenalty = "if(/logo|facebook|minister/.test([el.alt,el.title,el.id,typeof el.className==='string'?el.className:''].join(' ').toLowerCase()))n-=500;";
  if (!code.includes(oldCaptchaPenalty)) {
    throw new Error('AutoVerifica v4 preload: CAPTCHA patch target not found');
  }
  code = code.replace(oldCaptchaPenalty, newCaptchaPenalty);

  // Serve a cleaner root page without the misleading manual-km sentence.
  const staticLine = "app.use(express.static(path.join(__dirname, 'public-v4'), { extensions: ['html'] }));";
  const cleanRoot = `app.get(['/', '/index.html'], (req, res) => {
  const htmlPath = path.join(__dirname, 'public-v4', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8')
    .replace('<p class="micro">Nessun chilometraggio da inserire manualmente.</p>', '');
  res.type('html').send(html);
});
${staticLine}`;
  if (!code.includes(staticLine)) {
    throw new Error('AutoVerifica v4 preload: static route patch target not found');
  }
  code = code.replace(staticLine, cleanRoot);

  mod._compile(code, filename);
};
