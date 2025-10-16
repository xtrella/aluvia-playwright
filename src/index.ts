import * as playwright from "playwright";
const { Page } = playwright as any;

if (Page && Page.prototype && typeof Page.prototype.goto === "function") {
  const originalGoto = Page.prototype.goto;
  Page.prototype.goto = async function (
    url: string,
    options?: Parameters<typeof originalGoto>[1]
  ) {
    console.log("[aluvia-playwright] Patched goto:", url);
    // You can add more custom logic here
    return await originalGoto.apply(this, [url, options]);
  };
}

export * from "playwright";
