import { chromium, expect } from "@playwright/test";

interface ProgressUi {
  expectStatus(text: string): Promise<void>;
  expectNotification(text: string): Promise<void>;
  dispose(): Promise<void>;
}

/** Inspect the actual workbench when the native acceptance run enables UI inspection. */
export async function connectProgressUi(): Promise<ProgressUi | undefined> {
  const port = process.env["SPECWRIGHT_WORKBENCH_PORT"];
  if (!port) {
    if (process.env["SPECWRIGHT_PROGRESS_UI"] === "1") {
      throw new Error("UI acceptance requires the runner's workbench inspection port");
    }
    return undefined;
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes("workbench"));
  if (!page) {
    await browser.close();
    throw new Error("UI acceptance could not find the VS Code workbench");
  }
  return {
    expectStatus: async (text) => {
      const item = page.locator(".part.statusbar .statusbar-item")
        .filter({ hasText: "Specwright:" });
      await expect(item).toBeVisible({ timeout: 10_000 });
      await expect(item).toHaveText(`Specwright: ${text}`, { timeout: 10_000 });
    },
    expectNotification: async (text) => {
      const message = page.locator(".notifications-toasts .notification-list-item")
        .filter({ hasText: text });
      await expect(message).toBeVisible({ timeout: 10_000 });
    },
    dispose: () => browser.close(),
  };
}
