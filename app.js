const { chromium } = require("./dist/index");

(async () => {
  const browser = await chromium.launch({
    headless: false,
  });
  const page = await browser.newPage();
  await page.goto("https://github.com/xtrella/aluvia-playwright");
  const title = await page.title();
  console.log(title);

  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
})();
