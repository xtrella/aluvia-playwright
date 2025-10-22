import { EventEmitter } from "node:events";

export type MockPage = EventEmitter & {
  goto: (url: string, opts?: any) => Promise<any>;
  context: () => MockContext;
  viewportSize: () => { width: number; height: number } | null;
  evaluate: (fn: any) => Promise<string>;
  on: EventEmitter["on"];
  off: EventEmitter["off"];
  emit: EventEmitter["emit"];
};

export type MockContext = {
  storageState: () => Promise<any>;
  browser: () => MockBrowser | null;
  newPage: () => Promise<MockPage>;
};

export type MockBrowser = {
  newContext: (opts?: any) => Promise<MockContext>;
  newPage: () => Promise<MockPage>;
  close: () => Promise<void>;
};

function makePage(ctx: MockContext, gotoImpl: any): MockPage {
  const ev = new EventEmitter() as MockPage;

  ev.goto = gotoImpl;
  ev.context = () => ctx;
  ev.viewportSize = () => ({ width: 1280, height: 720 });
  ev.evaluate = async () => "MockUA";

  // stub used by wrapper
  (ev as any).waitForFunction = async (_fn: any, _opts?: any) => undefined;

  // wire event methods
  // @ts-ignore
  ev.on = ev.addListener.bind(ev);
  // @ts-ignore
  ev.off = ev.removeListener.bind(ev);
  // @ts-ignore
  ev.emit = ev.emit.bind(ev);

  return ev;
}

function makeBrowser(gotoImpl: any): MockBrowser {
  const browser: MockBrowser = {
    newContext: async (_opts?: any) => {
      const ctx: MockContext = {
        storageState: async () => ({}),
        browser: () => browser,
        newPage: async () => makePage(ctx, gotoImpl),
      };
      return ctx;
    },
    newPage: async () => {
      const ctx = await browser.newContext();
      return ctx.newPage();
    },
    close: async () => {},
  };
  return browser;
}

function makeBrowserType() {
  let currentGotoImpl: any = async () => ({ ok: true, status: 200 });
  return {
    __setGotoImpl: (impl: any) => (currentGotoImpl = impl),
    launch: async (_opts?: any) => makeBrowser(currentGotoImpl),
    launchPersistentContext: undefined,
  };
}

export const chromium = makeBrowserType();
export const firefox = makeBrowserType();
export const webkit = makeBrowserType();

export type Browser = any;
export type BrowserType = any;
export type BrowserContext = any;
export type Page = MockPage;
export type LaunchOptions = any;
export type BrowserContextOptions = any;
export type Response = any;
