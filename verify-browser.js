const puppeteer = require('puppeteer');

(async () => {
  const executable = puppeteer.executablePath();
  console.log('PUPPETEER_EXECUTABLE', executable);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
  });
  console.log('PUPPETEER_BROWSER_OK');
  await browser.close();
})().catch(err => {
  console.error('PUPPETEER_BROWSER_FAIL', err && err.stack ? err.stack : err);
  process.exit(1);
});
