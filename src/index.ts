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
const EMIT_ORIGINAL = Symbol.for("aluvia.emitOriginal");

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

function backoffDelay(attempt: number) {
  const base = ALUVIA_BACKOFF_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 100;
  return base + jitter;
}

function matchRetryable(err: any): boolean {
  if (!err) return false;

  const txt = String(err.message || err.toString() || "");
  const code = String(err.code ?? "");
  const name = String(err.name ?? "");

  return ALUVIA_RETRY_ON.some((pattern) => {
    if (!pattern) return false;
    try {
      // If pattern starts and ends with '/', treat as RegExp
      if (pattern.startsWith("/") && pattern.endsWith("/")) {
        const re = new RegExp(pattern.slice(1, -1));
        return re.test(txt) || re.test(code) || re.test(name);
      }

      return (
        txt.includes(pattern) ||
        code.includes(pattern) ||
        name.includes(pattern)
      );
    } catch {
      return (
        txt.includes(pattern) ||
        code.includes(pattern) ||
        name.includes(pattern)
      );
    }
  });
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
      const emitOriginal =
        (fromPage as any)[EMIT_ORIGINAL] ||
        (typeof (fromPage as any).emit === "function"
          ? (fromPage as any).emit.bind(fromPage)
          : undefined);

      if (emitOriginal) {
        emitOriginal(ev, ...args);
      }
    };
    // @ts-ignore
    fromPage.__aluvia_mirrors[ev] = handler;
    toPage.on(ev as any, handler as any);
  }
}

function forwardAllMethods(fromPage: Page, toPage: Page) {
  (fromPage as any)[TARGET] = toPage;
  // Save the original emit once (used by mirrorEvents)
  if (
    !(fromPage as any)[EMIT_ORIGINAL] &&
    typeof (fromPage as any).emit === "function"
  ) {
    (fromPage as any)[EMIT_ORIGINAL] = (fromPage as any).emit.bind(fromPage);
  }
  mirrorEvents(fromPage, toPage);

  const proto = Object.getPrototypeOf(toPage);
  const names = new Set([
    ...Object.getOwnPropertyNames(proto),
    ...Object.getOwnPropertyNames(toPage),
  ]);

  for (const name of names) {
    // Skip symbols
    if (typeof name === "symbol") continue;
    // Skip constructor and emit
    if (name === "constructor" || name === "emit") continue;
    // Skip properties that start with _ (Playwright internals)
    if (typeof name === "string" && name.startsWith("_")) continue;
    // Skip known Playwright internals that can cause recursion
    if (
      [
        "_events",
        "_eventListeners",
        "_guid",
        "_channel",
        "_initializer",
        "_wrapApiCall",
      ].includes(name)
    ) {
      continue;
    }

    const desc =
      Object.getOwnPropertyDescriptor(proto, name) ||
      Object.getOwnPropertyDescriptor(toPage, name);

    // Forward methods
    if (typeof (toPage as any)[name] === "function") {
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
    } else if (desc && (desc.get || desc.value !== undefined)) {
      // Forward non-function properties (getters/values) dynamically
      // Only define if not already defined as a getter
      const existing = Object.getOwnPropertyDescriptor(fromPage, name);
      if (!existing || typeof existing.get !== "function") {
        try {
          Object.defineProperty(fromPage, name, {
            configurable: true,
            enumerable: true,
            get() {
              const active = (fromPage as any)[TARGET] || toPage;
              return (active as any)[name];
            },
            set(val) {
              const active = (fromPage as any)[TARGET] || toPage;
              (active as any)[name] = val;
            },
          });
        } catch {
          // ignore
        }
      }
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
    this: Page,
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
          if (ALUVIA_BACKOFF_MS) await sleep(backoffDelay(attempt));
        }
      } else {
        const proxy = await getProxy().catch((e) => {
          lastErr = e;
          return undefined;
        });
        if (!proxy) break;

        try {
          const { page: newPage } = await relaunchWithProxy(
            browserType,
            launchDefaults,
            contextDefaults,
            proxy,
            this // old page
          );

          // Teleport future calls & events to the new page
          forwardAllMethods(this, newPage);

          const resp = await newPage.goto(url, {
            ...(options ?? {}),
            waitUntil: options?.waitUntil ?? "domcontentloaded",
          });

          // simple readiness gate
          await (newPage as any).waitForFunction(
            () =>
              typeof document !== "undefined" &&
              !!document.title &&
              document.title.trim().length > 0,
            { timeout: 15000 }
          );

          return resp ?? null;
        } catch (err) {
          lastErr = err;
          if (ALUVIA_BACKOFF_MS) await sleep(backoffDelay(attempt));
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

  // Guard for mocks that don't implement newPage
  if (typeof (ctx as any).newPage !== "function") {
    (ctx as any)[PATCHED] = true;
    return ctx;
  }

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

  if (typeof (bt as any).launchPersistentContext === "function") {
    const origLPC = (bt as any).launchPersistentContext.bind(bt);
    (bt as any).launchPersistentContext = async function (
      userDataDir: string,
      launchOptions: LaunchOptions = {},
      contextOptions: BrowserContextOptions = {}
    ) {
      const ctx = await origLPC(userDataDir, launchOptions, contextOptions);
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
