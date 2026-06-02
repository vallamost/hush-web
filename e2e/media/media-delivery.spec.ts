/**
 * media-delivery.spec.ts (HUSHHQ-107)
 *
 * Proves two REAL browser clients send and receive each other's audio + video
 * through the real server + real LiveKit, with FrameCryptor decryptFailures === 0
 * and the media key bound to the current MLS epoch.
 *
 * Each client establishes a genuine E2EE identity (real register + PIN via the
 * build-gated bridge), then both join the same seeded voice channel, publish mic
 * + camera, and we assert on the OUTCOME: rising inbound RTP on each remote and
 * a clean FrameCryptor (no decrypt failures, key index == epoch % 256).
 *
 * Covered:     two-client audio/video delivery through real server + LiveKit;
 *              FrameCryptor decryptFailures === 0; media key epoch binding.
 * Not covered: screen-share (HUSHHQ-110); real-device capture (fake media used);
 *              OS/browser matrix; CI gating (deferred).
 *
 * Accounts are destroyed with the throwaway postgres on teardown (no dev DB).
 */
import { test, expect, type Page } from '@playwright/test';

import {
  injectInstanceSelection,
  openRegistration,
  registerViaApp,
  seedVoiceChannel,
  unlockViaApp,
  voiceChannelPath,
} from './fixtures/session.js';

const JOIN_TIMEOUT_MS = 40_000;
const CONNECT_TIMEOUT_MS = 90_000;
const MEDIA_FLOW_TIMEOUT_MS = 40_000;
const LIVENESS_SAMPLE_GAP_MS = 1_500;

interface InboundStats {
  audioBytes: number;
  videoFrames: number;
}

/** Reads aggregate inbound RTP across all remote tracks via getStats(). */
async function inboundStats(page: Page): Promise<InboundStats> {
  return page.evaluate(async () => {
    const room = (window as unknown as { __hushRoom?: any }).__hushRoom;
    const out = { audioBytes: 0, videoFrames: 0 };
    if (!room) return out;
    for (const participant of room.remoteParticipants.values()) {
      for (const pub of participant.trackPublications.values()) {
        const report: RTCStatsReport | undefined = await pub.track?.getRTCStatsReport?.();
        report?.forEach((r: any) => {
          if (r.type !== 'inbound-rtp') return;
          if (r.kind === 'audio') out.audioBytes += r.bytesReceived ?? 0;
          if (r.kind === 'video') out.videoFrames += r.framesDecoded ?? 0;
        });
      }
    }
    return out;
  });
}

async function waitForRemote(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const room = (window as unknown as { __hushRoom?: any }).__hushRoom;
      return Boolean(room && room.remoteParticipants && room.remoteParticipants.size >= 1);
    },
    undefined,
    { timeout: MEDIA_FLOW_TIMEOUT_MS },
  );
}

/**
 * Force-dismisses first-run interstitial modals (outdated-server, "What's new")
 * by their dismiss buttons. Targets the topmost (.last()) and force-clicks so a
 * stacked overlay cannot intercept. Only "Got it"/"Dismiss" are used so the
 * prejoin dialog (Cancel / Join call) is never closed by accident.
 */
async function dismissInterstitials(page: Page): Promise<void> {
  for (const name of ['Got it', 'Dismiss']) {
    const btn = page.getByRole('button', { name }).last();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ force: true, timeout: 2_000 }).catch(() => {});
    }
  }
}

/**
 * Settles the channel page after the reload: the app either auto-unlocks via the
 * cross-reload session key (performRegister wrote it) or shows the PIN screen.
 * Waits for any boot-complete marker, then unlocks if the PIN gate is up.
 */
async function reachChannelReady(page: Page): Promise<void> {
  const unlockHeading = page.getByRole('heading', { name: 'Unlock Hush' });
  await expect(
    unlockHeading
      .or(page.getByRole('button', { name: 'Got it' }))
      .or(page.getByRole('button', { name: 'Join call' }))
      .or(page.getByRole('button', { name: 'Start video' }))
      .or(page.getByRole('button', { name: 'Stop video' }))
      .first(),
  ).toBeVisible({ timeout: JOIN_TIMEOUT_MS });
  if (await unlockHeading.isVisible().catch(() => false)) {
    await unlockViaApp(page);
  }
}

/**
 * Drives the channel page into a connected call with the camera ON. One resilient
 * loop because the second participant's LiveKit connection can briefly revert to
 * the prejoin dialog while connecting, and first-run modals (outdated-server,
 * what's new) can overlay the controls in any order. Each pass: dismiss
 * interstitials, click "Join call" if the prejoin is up, click "Start video" if
 * the in-call camera control is up. Success when the camera is on (Stop video).
 *
 * The in-call camera control appears in both the sidebar voice widget and the
 * main controls-bar; either toggles the same local track, so target the first.
 */
async function enterCallAndPublish(page: Page): Promise<void> {
  const joinBtn = page.getByRole('button', { name: 'Join call' }).first();
  const startVideo = page.getByRole('button', { name: 'Start video' }).first();
  const stopVideo = page.getByRole('button', { name: 'Stop video' }).first();

  await expect(async () => {
    await dismissInterstitials(page);
    if (await joinBtn.isVisible().catch(() => false)) {
      await joinBtn.click({ timeout: 3_000 }).catch(() => {});
    }
    if (await startVideo.isVisible().catch(() => false)) {
      await startVideo.click({ timeout: 3_000 }).catch(() => {});
    }
    await expect(stopVideo).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: CONNECT_TIMEOUT_MS });
}

test('two clients send and receive each other audio+video with E2EE intact', async ({
  browser,
}) => {
  // Heavy flow: two real registrations + two channel reloads + media convergence,
  // with a generous per-client connect budget for the second participant.
  test.setTimeout(300_000);
  await openRegistration();

  const suffix = `${Date.now().toString(36)}`;
  const ctxA = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const ctxB = await browser.newContext({ permissions: ['microphone', 'camera'] });

  await injectInstanceSelection(ctxA);
  await injectInstanceSelection(ctxB);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  for (const [name, page] of [['A', pageA], ['B', pageB]] as const) {
    page.on('pageerror', (err) => process.stdout.write(`[page${name} error] ${err.message}\n`));
  }

  // 1. Two real identities (real register + PIN).
  await pageA.goto('/');
  await pageB.goto('/');
  const a = await registerViaApp(pageA, `e2e-a-${suffix}`);
  const b = await registerViaApp(pageB, `e2e-b-${suffix}`);

  // 2. Shared voice channel with both as members.
  const { serverId, channelId } = await seedVoiceChannel([a.userId, b.userId]);
  const path = voiceChannelPath(serverId, channelId);

  // 3. Navigate to the channel (reload) and settle to a join-ready state.
  await pageA.goto(path);
  await reachChannelReady(pageA);
  await pageB.goto(path);
  await reachChannelReady(pageB);

  // 4. Join voice + publish mic/camera. A first so it creates the MLS group,
  //    then B joins via external commit (the real convergence path).
  await enterCallAndPublish(pageA);
  await enterCallAndPublish(pageB);

  // Both must observe each other (real LiveKit subscribe + MLS convergence).
  await waitForRemote(pageA);
  await waitForRemote(pageB);

  // 5. Liveness: inbound audio bytes + decoded video frames must rise on both.
  for (const page of [pageA, pageB]) {
    const s1 = await inboundStats(page);
    await page.waitForTimeout(LIVENESS_SAMPLE_GAP_MS);
    const s2 = await inboundStats(page);
    expect(s2.audioBytes, 'inbound audio must increase').toBeGreaterThan(s1.audioBytes);
    expect(s2.videoFrames, 'decoded video frames must increase').toBeGreaterThan(s1.videoFrames);
  }

  // 6. The real assertion: E2EE correctness on both sides.
  for (const page of [pageA, pageB]) {
    const stats = await page.evaluate(
      () => (window as unknown as { __hushE2eeStats?: any }).__hushE2eeStats,
    );
    expect(stats, '__hushE2eeStats must be installed (diag build)').toBeTruthy();
    expect(stats.decryptFailures, 'FrameCryptor decrypt failures').toBe(0);
    expect(stats.mediaKeyEpoch, 'media key epoch bound').toBeGreaterThanOrEqual(0);
    expect(stats.keyIndex, 'key index == epoch % 256').toBe(stats.mediaKeyEpoch % 256);
  }

  await ctxA.close();
  await ctxB.close();
});
