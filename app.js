const { chromium } = require("./dist/index");

(async () => {
  const browser = await chromium.launch({
    headless: false,
  });
  const page = await browser.newPage();
  await page.goto("https://www.binance.com/en");
})();
