import Aluvia from "aluvia-ts-sdk";

import * as pw from "playwright";
import type {
  Browser,
  BrowserContext,
  BrowserType,
  Page,
  LaunchOptions,
  BrowserContextOptions,
} from "playwright";

const PATCHED = Symbol.for("aluvia.patched");
const TARGET = Symbol.for("aluvia.targetPage");

const MAX_RETRIES = 1;
const BACKOFF_MS = 300;
const RETRY_ON = ["ECONNRESET", "ETIMEDOUT", "net::ERR", "Timeout"];

const aluvia = new Aluvia(
  "51bb6928fc0c9468ef89da865ca7159bcda170e0d7b07c2f0617bffec2c70e60"
);

function matchRetryable(err: any): boolean {
  const txt = (err && (err.message || err.toString())) || "";
  return RETRY_ON.some((k) => txt.includes(k));
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function getProxy() {
  const proxy = await aluvia.first();
  if (!proxy) return null;

  return {
    server: `http://${proxy.host}:${proxy.httpPort}`,
    username: proxy.username,
    password: proxy.password,
  };
}

function forwardAllMethods(fromPage: Page, toPage: Page) {
  (fromPage as any)[TARGET] = toPage;
  const proto = Object.getPrototypeOf(toPage);
  const names = new Set([
    ...Object.getOwnPropertyNames(proto),
    ...Object.getOwnPropertyNames(toPage),
  ]);

  for (const name of names) {
    if (name === "constructor") continue;
    const fn = (toPage as any)[name];
    if (typeof fn !== "function") continue;
    if ((fromPage as any)[name]?.[PATCHED]) continue;

    try {
      (fromPage as any)[name] = function (...args: any[]) {
        const active = (fromPage as any)[TARGET] || toPage;
        return (active as any)[name](...args);
      };
      (fromPage as any)[name][PATCHED] = true;
    } catch {
      // ignore
    }
  }
}

async function relaunchWithProxy(
  browserType: BrowserType<Browser>,
  launchDefaults: LaunchOptions,
  contextDefaults: BrowserContextOptions,
  proxy: any
) {
  const browser = await browserType.launch({ ...launchDefaults, proxy });
  const context = await browser.newContext({ ...contextDefaults });
  const page = await context.newPage();
  return { browser, context, page };
}

function wrapPage(
  page: Page,
  browserType: BrowserType<Browser>,
  launchDefaults: LaunchOptions,
  contextDefaults: BrowserContextOptions
) {
  if (!page || (page as any)[PATCHED]) return page;

  const originalGoto = page.goto.bind(page);
  page.goto = async function patchedGoto(
    url: string,
    options?: Parameters<Page["goto"]>[1]
  ) {
    let lastErr: any;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt === 0) {
        try {
          return await originalGoto(url, options);
        } catch (err) {
          lastErr = err;
          if (!matchRetryable(err)) break;
          if (BACKOFF_MS) await sleep(BACKOFF_MS);
        }
      } else {
        const proxy = await getProxy();
        console.log(JSON.stringify(proxy));
        if (!proxy) break;

        try {
          const { page: newPage } = await relaunchWithProxy(
            browserType,
            launchDefaults,
            contextDefaults,
            proxy
          );
          forwardAllMethods(page, newPage);
          return await newPage.goto(url, options);
        } catch (err) {
          lastErr = err;
          if (BACKOFF_MS) await sleep(BACKOFF_MS);
        }
      }
    }
    throw lastErr;
  } as Page["goto"];

  (page as any)[PATCHED] = true;
  return page;
}

function wrapContext(
  ctx: BrowserContext,
  browserType: BrowserType<Browser>,
  launchDefaults: LaunchOptions,
  contextDefaults: BrowserContextOptions
) {
  if (!ctx || (ctx as any)[PATCHED]) return ctx;

  const origNewPage = ctx.newPage.bind(ctx);
  ctx.newPage = async (...args) => {
    const page = await origNewPage(...args);
    return wrapPage(page, browserType, launchDefaults, contextDefaults);
  };

  (ctx as any)[PATCHED] = true;
  return ctx;
}

function wrapBrowser(
  browser: Browser,
  browserType: BrowserType<Browser>,
  launchDefaults: LaunchOptions,
  contextDefaults: BrowserContextOptions
) {
  if (!browser || (browser as any)[PATCHED]) return browser;

  const origNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const ctx = await origNewContext(...args);
    return wrapContext(ctx, browserType, launchDefaults, contextDefaults);
  };

  const origNewPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await origNewPage(...args);
    return wrapPage(page, browserType, launchDefaults, contextDefaults);
  };

  (browser as any)[PATCHED] = true;
  return browser;
}

function wrapBrowserType(key: "chromium" | "firefox" | "webkit") {
  const bt = (pw as any)[key] as BrowserType<Browser>;
  if (!bt || (bt as any)[PATCHED]) return;

  const origLaunch = bt.launch.bind(bt);
  bt.launch = async function (launchOptions: LaunchOptions = {}) {
    const browser = await origLaunch(launchOptions);
    const contextDefaults: BrowserContextOptions = {};
    wrapBrowser(browser, bt, launchOptions, contextDefaults);
    return browser;
  };

  if (typeof bt.launchPersistentContext === "function") {
    const origLPC = bt.launchPersistentContext.bind(bt);
    bt.launchPersistentContext = async function (
      userDataDir: string,
      launchOptions: LaunchOptions = {},
      contextOptions: BrowserContextOptions = {}
    ) {
      const ctx = await origLPC(userDataDir, launchOptions);
      wrapContext(ctx, bt, launchOptions, contextOptions);
      return ctx;
    };
  }

  (bt as any)[PATCHED] = true;
}

(["chromium", "firefox", "webkit"] as const).forEach(wrapBrowserType);
export = pw;
