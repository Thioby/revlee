import { chromium, type Browser, type Page } from "playwright";
import path from "node:path";
import fs from "node:fs";
import type { Observation, UiNode } from "../types.js";
import { fingerprintOf, renderSnapshot, type Action, type DeviceAdapter, type DeviceOptions } from "./types.js";

/**
 * Web adapter on raw Playwright. Produces agent-device-style accessibility snapshots
 * (refs @eN, role, name, testID) so the executor prompt is identical across adapters.
 */
export class PlaywrightAdapter implements DeviceAdapter {
  readonly platform = "web";
  private browser!: Browser;
  private page!: Page;
  private shotCounter = 0;
  constructor(private opts: DeviceOptions) {}

  async open(url: string): Promise<Observation> {
    this.browser = await chromium.launch({
      headless: !this.opts.headed,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
      args: process.env.REVLEE_NO_SANDBOX ? ["--no-sandbox"] : [],
    });
    const ctx = await this.browser.newContext({
      viewport: { width: 420, height: 820 },
      recordVideo: process.env.REVLEE_VIDEO === "0" ? undefined : { dir: path.join(this.opts.evidenceDir, "video"), size: { width: 420, height: 820 } },
    });
    this.page = await ctx.newPage();
    await this.page.goto(url, { waitUntil: "networkidle" });
    return this.observe({ screenshot: true, label: "open" });
  }

  async observe(opts: { screenshot?: boolean; label?: string } = {}): Promise<Observation> {
    await this.page.waitForLoadState("domcontentloaded");
    const raw = await this.page.evaluate(() => {
      const ROLE_BY_TAG: Record<string, string> = { button: "button", a: "link", input: "textbox", textarea: "textbox", select: "combobox", h1: "heading", h2: "heading", h3: "heading", p: "text", span: "text", strong: "text", div: "generic", nav: "navigation", header: "banner", main: "main", li: "listitem", img: "image", label: "text" };
      const isVisible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const cs = getComputedStyle(el as HTMLElement);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
      };
      const out: { role: string; name: string; testId?: string; value?: string; interactive: boolean; idx: number }[] = [];
      let idx = 0;
      document.querySelectorAll("[data-revlee-ref]").forEach((el) => el.removeAttribute("data-revlee-ref"));
      const all = Array.from(document.body.querySelectorAll("*"));
      for (const el of all) {
        if (!isVisible(el)) continue;
        const tag = el.tagName.toLowerCase();
        if (["script", "style", "svg", "path", "nav", "header", "main", "body", "html"].includes(tag)) continue;
        const roleAttr = el.getAttribute("role");
        let role = roleAttr || ROLE_BY_TAG[tag] || "generic";
        const interactive = ["button", "link", "textbox", "combobox", "checkbox", "tab", "menuitem", "switch"].includes(role) || el.hasAttribute("onclick") || (el as HTMLElement).tabIndex >= 0;
        const ownText = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent?.trim() || "").join(" ").trim();
        const label = el.getAttribute("aria-label") || (el as HTMLInputElement).placeholder || "";
        const name = (label || (interactive ? (el.textContent || "").trim() : ownText)).replace(/\s+/g, " ").slice(0, 120);
        if (role === "generic" && !name && !el.getAttribute("data-testid")) continue;
        if (!interactive && !name && !el.getAttribute("data-testid")) continue;
        const testId = el.getAttribute("data-testid") || undefined;
        const value = tag === "input" || tag === "textarea" || tag === "select" ? (el as HTMLInputElement).value : label && ownText ? ownText : undefined;
        idx++;
        el.setAttribute("data-revlee-ref", `e${idx}`);
        out.push({ role, name, testId, value, interactive, idx });
      }
      return { title: (document.querySelector("#screen-title, h1")?.textContent || document.title).trim(), nodes: out };
    });
    const nodes: UiNode[] = raw.nodes.map((n) => ({ ref: `e${n.idx}`, role: n.role, name: n.name, testId: n.testId, value: n.value, interactive: n.interactive }));
    const obs: Observation = {
      title: raw.title,
      nodes,
      snapshotText: renderSnapshot(raw.title, nodes),
      fingerprint: fingerprintOf(raw.title, nodes),
    };
    if (opts.screenshot) obs.screenshotPath = await this.screenshot(opts.label ?? "observe");
    return obs;
  }

  async act(action: Action, opts: { screenshot?: boolean; label?: string } = {}): Promise<Observation> {
    const target = (a: { ref?: string; selector?: string }) => {
      if (a.ref) return this.page.locator(`[data-revlee-ref="${a.ref.replace(/^@/, "")}"]`);
      if (a.selector) return this.page.locator(a.selector);
      throw new Error("tap/type needs ref or selector");
    };
    switch (action.kind) {
      case "tap":
        await target(action).first().click({ timeout: 5000 });
        break;
      case "type":
        await target(action).first().fill(action.text, { timeout: 5000 });
        break;
      case "scroll":
        await this.page.mouse.wheel(0, action.direction === "down" ? 600 : -600);
        break;
      case "open_link":
        await this.page.goto(action.url, { waitUntil: "networkidle" });
        break;
      case "wait":
        await this.page.waitForTimeout(action.ms);
        break;
      case "back":
        await this.page.goBack();
        break;
    }
    await this.page.waitForTimeout(250); // settle
    return this.observe({ screenshot: opts.screenshot, label: opts.label });
  }

  async waitFor(q: { text?: string; selector?: string; absent?: boolean; timeoutMs?: number }): Promise<boolean> {
    const timeout = q.timeoutMs ?? 5000;
    const loc = q.selector ? this.page.locator(q.selector) : this.page.getByText(q.text ?? "", { exact: false });
    try {
      await loc.first().waitFor({ state: q.absent ? "hidden" : "visible", timeout });
      return true;
    } catch {
      return false;
    }
  }

  async screenshot(label: string): Promise<string> {
    const dir = path.join(this.opts.evidenceDir, "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${String(++this.shotCounter).padStart(3, "0")}-${label.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 40)}.png`);
    await this.page.screenshot({ path: file });
    return file;
  }

  async close(): Promise<void> {
    try {
      await this.page?.context().close();
    } finally {
      await this.browser?.close();
    }
  }
}
