import Aluvia from "aluvia-ts-sdk";
import dotenv from "dotenv";
import * as pw from "playwright";
import type {
  Browser,
  BrowserContext,
  BrowserType,
  Page,
  LaunchOptions,
  BrowserContextOptions,
  Response,
} from "playwright";

dotenv.config();

const PATCHED = Symbol.for("aluvia.patched");
const TARGET = Symbol.for("aluvia.targetPage");

const ALUVIA_MAX_RETRIES = parseInt(process.env.ALUVIA_MAX_RETRIES || "1", 10);
const ALUVIA_BACKOFF_MS = parseInt(process.env.ALUVIA_BACKOFF_MS || "300", 10);
const ALUVIA_RETRY_ON = process.env.ALUVIA_RETRY_ON?.split(",") || [
  "ECONNRESET",
  "ETIMEDOUT",
  "net::ERR",
  "Timeout",
];

const ALUVIA_API_KEY = process.env.ALUVIA_API_KEY || "";
if (!ALUVIA_API_KEY) {
  throw new Error(`ALUVIA_API_KEY environment variable is required`);
}

const aluvia = new Aluvia(ALUVIA_API_KEY);

function matchRetryable(err: any): boolean {
  const txt = (err && (err.message || err.toString())) || "";
  return ALUVIA_RETRY_ON.some((k) => txt.includes(k));
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function getProxy() {
  const proxy = await aluvia.first();

  if (!proxy) {
    throw new Error("Failed to get proxy from Aluvia");
  }

  return {
    server: `http://${proxy.host}:${proxy.httpPort}`,
    username: proxy.username,
    password: proxy.password,
  };
}

// Mirror common page events so existing listeners keep working
const MIRROR_EVENTS = [
  "close",
  "crash",
  "domcontentloaded",
  "download",
  "filechooser",
  "framedetached",
  "framenavigated",
  "load",
  "pageerror",
  "popup",
  "request",
  "requestfailed",
  "requestfinished",
  "response",
  "websocket",
  "console",
  "dialog",
  "video",
] as const;

function mirrorEvents(fromPage: Page, toPage: Page) {
  // @ts-ignore
  fromPage.__aluvia_mirrors ??= {};
  for (const ev of MIRROR_EVENTS) {
    // detach old
    // @ts-ignore
    if (fromPage.__aluvia_mirrors[ev]) {
      // @ts-ignore
      toPage.off?.(ev, fromPage.__aluvia_mirrors[ev]);
    }
    const handler = (...args: any[]) => {
      // @ts-ignore
      fromPage.emit?.(ev, ...args);
    };
    // @ts-ignore
    fromPage.__aluvia_mirrors[ev] = handler;
    toPage.on(ev as any, handler as any);
  }
}

function forwardAllMethods(fromPage: Page, toPage: Page) {
  (fromPage as any)[TARGET] = toPage;
  mirrorEvents(fromPage, toPage);

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
  proxy: { server: string; username?: string; password?: string },
  oldPage: Page
) {
  // Capture state/shape from old session
  const oldCtx = oldPage.context();
  const state = await oldCtx.storageState().catch(() => undefined);
  const vp = oldPage.viewportSize();
  const ua = await oldPage
    .evaluate(() => navigator.userAgent)
    .catch(() => undefined);

  // Close old browser to avoid 2 windows lingering
  try {
    await oldCtx.browser()?.close();
  } catch {}

  const retryLaunch: LaunchOptions = {
    headless: launchDefaults.headless ?? true,
    ...launchDefaults,
    proxy,
  };

  const browser = await browserType.launch(retryLaunch);
  const context = await browser.newContext({
    ...contextDefaults,
    storageState: state,
    userAgent: ua ?? contextDefaults.userAgent,
    viewport: vp ?? contextDefaults.viewport,
  });
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
  ): Promise<Response | null> {
    let lastErr: any;
    for (let attempt = 0; attempt <= ALUVIA_MAX_RETRIES; attempt++) {
      if (attempt === 0) {
        try {
          return await originalGoto(url, options);
        } catch (err) {
          lastErr = err;
          if (!matchRetryable(err)) break;
          if (ALUVIA_BACKOFF_MS) await sleep(ALUVIA_BACKOFF_MS);
        }
      } else {
        const proxy = await getProxy();
        if (!proxy) break;

        try {
          const { page: newPage } = await relaunchWithProxy(
            browserType,
            launchDefaults,
            contextDefaults,
            proxy,
            page // pass old page to carry state & close old browser
          );

          // Teleport future calls & events to the new page
          forwardAllMethods(page, newPage);

          const resp = await newPage.goto(url, {
            ...(options ?? {}),
            waitUntil: options?.waitUntil ?? "domcontentloaded",
          });

          await newPage.waitForFunction(
            () =>
              typeof document !== "undefined" &&
              !!document.title &&
              document.title.trim().length > 0,
            { timeout: 15000 }
          );

          return resp ?? null;
        } catch (err) {
          lastErr = err;
          if (ALUVIA_BACKOFF_MS) await sleep(ALUVIA_BACKOFF_MS);
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
export const chromium = pw.chromium;
export const firefox = pw.firefox;
export const webkit = pw.webkit;

export * from "playwright";
