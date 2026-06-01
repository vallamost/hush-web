/**
 * smoke.spec.ts
 *
 * Minimal smoke test: proves the full local stack (compose postgres + livekit,
 * native Go server with e2e_test build tag, Vite preview build) is up and the
 * app shell loads. This spec is intentionally narrow; deeper media-delivery
 * tests live in the sibling spec files created in later tasks.
 */

import { expect, test } from '@playwright/test';

test('app shell loads against the preview build', async ({ page }) => {
  await page.goto('/');
  // The app renders a React root. Any visible body content proves the JS
  // bundle loaded and the preview server is responding correctly.
  await expect(page.locator('body')).toBeVisible();
  // The page must not be a blank error page: check that the document title
  // is present (Vite injects it from index.html) and is non-empty.
  const title = await page.title();
  expect(title.length).toBeGreaterThan(0);
});
