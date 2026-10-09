import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";

// The Conductor section on the unmodified app over the demo's fixture transport (site/demo/
// transport.ts), which starts with two cards: an answer for the Codex approval that blocks "Guard
// the export button", and a message for the idle "Why did the backup fail?". Approving an answer
// sends it through the prompt-answer route; approving a message only fills that pane's composer
// (nothing is sent: the demo's composer stays unsent until Enter). All files and traffic stay in
// this disposable, loopback-only app; no herdr session is opened. CONDUCTOR_SHOTS=<dir> keeps
// screenshots of the desktop and the phone.
const app = mkdtempSync(join(tmpdir(), "herdr-conductor-demo-"));
const shots = process.env["CONDUCTOR_SHOTS"];
if (shots) mkdirSync(shots, { recursive: true });

const WEB = "Guard the export button"; // codex, blocked on an approval
const INFRA = "Why did the backup fail?"; // idle
const MESSAGE = "Free some space under /var/backups, then run the backup again and tell me how it went.";

const cards = (page: Page) => page.locator(".conductor-card");
const card = (page: Page, title: string) => cards(page).filter({ has: page.locator(".conductor-card-title", { hasText: title }) });
const count = (page: Page) => page.locator(".conductor-section-count");
const agentStatus = (page: Page, title: string) => page.locator(".agents-sidebar .agent-item", { has: page.locator(".agent-title", { hasText: title }) }).locator(".sidebar-status").getAttribute("data-status");

async function withPage(browser: Browser, viewport: { width: number; height: number }, settings: object, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ viewport, locale: "en-US", hasTouch: viewport.width < 600, isMobile: viewport.width < 600 });
  try {
    await context.addInitScript((stored) => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", ...stored }));
    }, settings);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // the shell pane is on screen: the demo's own finish happens out of sight
    await page.goto(`${url}?pane=${encodeURIComponent(panes.shell)}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

let url = "";
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;

  try {
    const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      // the section lists both cards with the count, and approving a message only drafts it
      await withPage(browser, { width: 1280, height: 900 }, {}, async (page) => {
        await page.locator(".conductor-sidebar").waitFor();
        await cards(page).first().waitFor();
        assert.equal(await cards(page).count(), 2);
        assert.equal((await count(page).textContent())?.trim(), "2");
        assert.match(await card(page, WEB).textContent() ?? "", /Answer\s*Yes/);
        assert.match(await card(page, INFRA).textContent() ?? "", /Draft message\s*Free some space/);
        if (shots) await page.screenshot({ path: join(shots, "conductor-desktop.png") });

        await card(page, INFRA).getByRole("button", { name: "Approve" }).click();
        await page.locator(".composer-text").waitFor();
        await page.waitForFunction((expected) => (document.querySelector<HTMLTextAreaElement>(".composer-text")?.value ?? "") === expected, MESSAGE, { timeout: 5_000 });
        assert.equal(await agentStatus(page, INFRA), "idle", "approving a message sends nothing: the agent did not start working");
        await page.waitForTimeout(600);
        assert.equal(await agentStatus(page, INFRA), "idle");
        await cards(page).filter({ has: page.locator(".conductor-card-title", { hasText: INFRA }) }).waitFor({ state: "detached" });
        assert.equal((await count(page).textContent())?.trim(), "1");

        // approving an answer sends it through the prompt route: the blocked agent goes back to work
        assert.equal(await agentStatus(page, WEB), "blocked");
        await card(page, WEB).getByRole("button", { name: "Approve" }).click();
        await cards(page).first().waitFor({ state: "detached", timeout: 5_000 });
        await page.waitForFunction(() => document.querySelector(".conductor-section-count") === null, undefined, { timeout: 5_000 });
        await page.locator(`.agents-sidebar .agent-item:has(.agent-title:has-text("${WEB}")) .sidebar-status[data-status="working"]`).waitFor({ timeout: 5_000 });
      });
      console.log("PASS both cards are listed with their count; approving a message drafts it unsent, approving an answer answers the prompt");

      // dismissing a card closes it and leaves the pane alone
      await withPage(browser, { width: 1280, height: 900 }, {}, async (page) => {
        await cards(page).first().waitFor();
        await card(page, WEB).getByRole("button", { name: "Dismiss" }).click();
        await card(page, WEB).waitFor({ state: "detached" });
        assert.equal(await cards(page).count(), 1);
        assert.equal(await agentStatus(page, WEB), "blocked", "dismissing answers nothing");
      });
      console.log("PASS dismissing a card closes it and answers nothing");

      // a prompt answered some other way turns its answer card stale, with its reason and no Approve
      await withPage(browser, { width: 1280, height: 900 }, {}, async (page) => {
        await cards(page).first().waitFor();
        await page.locator(".agents-sidebar .agent-select", { hasText: WEB }).click();
        await page.locator(".prompt-card-option").first().click();
        const stale = card(page, WEB);
        await stale.locator(".conductor-card-stale").waitFor({ timeout: 5_000 });
        assert.match(await stale.locator(".conductor-card-stale").textContent() ?? "", /moved on from that prompt/);
        assert.equal(await stale.getByRole("button", { name: "Approve" }).count(), 0);
        assert.equal((await count(page).textContent())?.trim(), "1", "the count is of the cards that still wait");
        await stale.getByRole("button", { name: "Dismiss" }).click();
        await stale.waitFor({ state: "detached" });
      });
      console.log("PASS an answer card whose prompt was answered elsewhere goes stale, says why and can only be dismissed");

      // Settings can hide the section
      await withPage(browser, { width: 1280, height: 900 }, { showConductor: false }, async (page) => {
        await page.locator(".agents-sidebar").waitFor();
        await page.waitForTimeout(300);
        assert.equal(await page.locator(".conductor-sidebar").count(), 0);
      });
      console.log("PASS Settings hides the section");

      // a phone: the section is folded in the drawer with its count, opens, and nothing runs past the screen
      await withPage(browser, { width: 390, height: 844 }, {}, async (page) => {
        await page.locator(".drawer-toggle").click();
        await page.locator(".conductor-sidebar").waitFor();
        assert.equal((await count(page).textContent())?.trim(), "2", "a folded section still counts its cards");
        assert.equal(await page.locator(".conductor-contents").isHidden(), true);
        await page.locator(".conductor-section-toggle").click();
        await cards(page).first().waitFor();
        const geometry = await page.evaluate(() => {
          const width = window.innerWidth;
          const sidebar = document.querySelector<HTMLElement>(".conductor-contents")!;
          const buttons = [...document.querySelectorAll<HTMLElement>(".conductor-card-actions .btn")].map((button) => { const box = button.getBoundingClientRect(); return { left: box.left, right: box.right, height: box.height }; });
          return { width, page: document.documentElement.scrollWidth, contents: sidebar.scrollWidth - sidebar.clientWidth, buttons };
        });
        assert.ok(geometry.page <= geometry.width, `the page does not scroll sideways: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.contents <= 0, `the cards fit their column: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.buttons.length >= 4 && geometry.buttons.every((button) => button.left >= 0 && button.right <= geometry.width && button.height >= 36), `every button fits and is a tap target: ${JSON.stringify(geometry)}`);
        if (shots) await page.screenshot({ path: join(shots, "conductor-phone.png") });
      });
      console.log("PASS on a 390px phone the section folds with its count, opens, and every card and button fits");
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
