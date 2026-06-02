/**
 * probe.spec.ts (TEMPORARY - delete after investigation)
 *
 * Minimal probe: two injected sessions join a voice channel.
 * Dumps window.__hushRoom.remoteParticipants.size,
 * window.__hushE2eeStats, and console errors to stdout.
 *
 * Run: npm run e2e:media -- probe.spec.ts
 */

import { expect, test, chromium } from '@playwright/test';
import {
  createEphemeralSession,
  seedVoiceChannel,
  injectSession,
} from './fixtures/session.js';
import { PREVIEW_URL, SERVER_URL } from './constants.js';

const VOICE_JOIN_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test('probe: two sessions join voice channel', async ({ browser }) => {
  const sessionA = await createEphemeralSession();
  const sessionB = await createEphemeralSession();
  const { serverId, channelId } = await seedVoiceChannel([sessionA.userId, sessionB.userId]);

  console.log('[probe] sessionA userId:', sessionA.userId, 'deviceId:', sessionA.deviceId);
  console.log('[probe] sessionB userId:', sessionB.userId, 'deviceId:', sessionB.deviceId);
  console.log('[probe] serverId:', serverId, 'channelId:', channelId);

  const ctxA = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const ctxB = await browser.newContext({ permissions: ['microphone', 'camera'] });

  await injectSession(ctxA, sessionA);
  await injectSession(ctxB, sessionB);

  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Capture all console output (including errors and warnings).
  const logsA: string[] = [];
  const logsB: string[] = [];
  pageA.on('console', (msg) => {
    const text = `[${msg.type()}] ${msg.text()}`;
    logsA.push(text);
    // Print immediately for debugging
    process.stdout.write(`[pageA console] ${text}\n`);
  });
  pageB.on('console', (msg) => {
    const text = `[${msg.type()}] ${msg.text()}`;
    logsB.push(text);
  });
  pageA.on('pageerror', (err) => {
    process.stdout.write(`[pageA pageerror] ${err.message}\n`);
  });
  pageB.on('pageerror', (err) => {
    process.stdout.write(`[pageB pageerror] ${err.message}\n`);
  });

  // Build the voice channel URL: /{instanceHost}/{guildSlug}--{serverId}/{channelId}
  // The server names the server "e2e" (seed endpoint passes []byte("e2e") as name).
  const instanceHost = '127.0.0.1:8080';
  const guildSlug = `e2e--${serverId}`;
  const voiceUrl = `${PREVIEW_URL}/${instanceHost}/${guildSlug}/${channelId}`;
  console.log('[probe] voiceUrl:', voiceUrl);

  await pageA.goto(voiceUrl);
  await pageB.goto(voiceUrl);

  // Wait for the app to boot and attempt voice join.
  await sleep(10_000);

  // Take a screenshot to see page state.
  await pageA.screenshot({ path: '/tmp/probe-pageA.png', fullPage: true });
  await pageB.screenshot({ path: '/tmp/probe-pageB.png', fullPage: true });

  await sleep(5_000);

  // Dump state.
  const stateA = await pageA.evaluate(() => {
    const room = (window as any).__hushRoom;
    const stats = (window as any).__hushE2eeStats;
    return {
      hasRoom: !!room,
      diagEnabled: (window as any).__hushE2eeDiagEnabled ?? null,
      remoteParticipantsSize: room ? room.remoteParticipants?.size : null,
      e2eeStats: stats ?? null,
      url: window.location.href,
    };
  });
  const stateB = await pageB.evaluate(() => {
    const room = (window as any).__hushRoom;
    const stats = (window as any).__hushE2eeStats;
    return {
      hasRoom: !!room,
      diagEnabled: (window as any).__hushE2eeDiagEnabled ?? null,
      remoteParticipantsSize: room ? room.remoteParticipants?.size : null,
      e2eeStats: stats ?? null,
      url: window.location.href,
    };
  });

  console.log('[probe] pageA state:', JSON.stringify(stateA));
  console.log('[probe] pageB state:', JSON.stringify(stateB));
  // Print all logs that contain relevant keywords
  const relevantA = logsA.filter(l => /livekit|mls|e2ee|voice|credential|error|warn|E2EE|MLS|diag/i.test(l));
  const relevantB = logsB.filter(l => /livekit|mls|e2ee|voice|credential|error|warn|E2EE|MLS|diag/i.test(l));
  console.log('[probe] pageA relevant logs:', JSON.stringify(relevantA.slice(0, 30)));
  console.log('[probe] pageB relevant logs:', JSON.stringify(relevantB.slice(0, 30)));
  console.log('[probe] pageA ALL logs (last 20):', JSON.stringify(logsA.slice(-20)));
  console.log('[probe] pageB ALL logs (last 20):', JSON.stringify(logsB.slice(-20)));

  // Non-asserting: just dump and pass so we can read output.
  await ctxA.close();
  await ctxB.close();
});
