const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const dir = path.resolve('./sessions/my-quora-account/browser-profile');
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true,
    channel: 'chrome',
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const url = 'https://www.quora.com/What-are-good-hacks-and-tips-for-exercise-fitness-and-working-out';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const answerElements = await page.evaluate(() => {
    const list = [];
    for (const el of document.querySelectorAll('button, div[role="button"], a, [class*="puppeteer"]')) {
      const text = (el.innerText || el.textContent || '').trim();
      const aria = el.getAttribute('aria-label') || '';
      if (/^answer$/i.test(text) || /^answer$/i.test(aria) || el.className.includes('answer')) {
        list.push({
          tagName: el.tagName,
          className: el.className,
          text: text.slice(0, 40),
          aria,
          rect: el.getBoundingClientRect(),
        });
      }
    }
    return list;
  });

  console.log('Answer elements on page:', JSON.stringify(answerElements, null, 2));
  await ctx.close();
})();
