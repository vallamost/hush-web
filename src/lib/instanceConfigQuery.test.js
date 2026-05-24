import { describe, expect, it, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

import {
  INSTANCE_CONFIG_QUERY_ROOT,
  instanceConfigQueryKey,
  mergeInstanceConfigUpdate,
  normalizeInstanceConfig,
  removeInstanceConfigQuery,
  seedInstanceConfigQuery,
} from './instanceConfigQuery.js';

const INSTANCE_A = 'https://a.example.com';
const INSTANCE_B = 'https://b.example.com';

describe('instanceConfigQueryKey', () => {
  it('returns a stable key rooted under instance-config and scoped by origin', () => {
    expect(instanceConfigQueryKey(INSTANCE_A)).toEqual([
      INSTANCE_CONFIG_QUERY_ROOT,
      INSTANCE_A,
    ]);
  });

  it('normalizes the URL to its origin so trailing slash variants share a key', () => {
    expect(instanceConfigQueryKey('https://a.example.com/')).toEqual(
      instanceConfigQueryKey(INSTANCE_A),
    );
  });

  it('collapses unnormalizable input to a non-real bucket', () => {
    expect(instanceConfigQueryKey('')).toEqual([
      INSTANCE_CONFIG_QUERY_ROOT,
      '__unknown__',
    ]);
    expect(instanceConfigQueryKey(null)).toEqual([
      INSTANCE_CONFIG_QUERY_ROOT,
      '__unknown__',
    ]);
  });
});

describe('normalizeInstanceConfig', () => {
  it('drops the type discriminator', () => {
    expect(
      normalizeInstanceConfig({
        type: 'instance_updated',
        max_attachment_bytes: 1000,
      }),
    ).toEqual({
      max_attachment_bytes: 1000,
      maxAttachmentBytes: 1000,
    });
  });

  it('drops null and undefined fields without clobbering siblings', () => {
    expect(
      normalizeInstanceConfig({
        name: 'Hush HQ',
        iconUrl: null,
        registrationMode: undefined,
        screen_share_resolution_cap: '720p',
      }),
    ).toEqual({
      name: 'Hush HQ',
      screen_share_resolution_cap: '720p',
      screenShareResolutionCap: '720p',
    });
  });

  it('mirrors compat aliases in both directions', () => {
    expect(
      normalizeInstanceConfig({
        registrationMode: 'invite_only',
      }),
    ).toMatchObject({
      registrationMode: 'invite_only',
      registration_mode: 'invite_only',
    });

    expect(
      normalizeInstanceConfig({
        registration_mode: 'closed',
      }),
    ).toMatchObject({
      registrationMode: 'closed',
      registration_mode: 'closed',
    });
  });

  it('lets camelCase win when both spellings are supplied', () => {
    // Server's GET /api/handshake response shape uses camelCase as the
    // primary key; the snake_case alias is a back-compat mirror.
    expect(
      normalizeInstanceConfig({
        registrationMode: 'open',
        registration_mode: 'closed',
      }),
    ).toMatchObject({
      registrationMode: 'open',
      registration_mode: 'open',
    });
  });

  it('passes through unknown fields untouched (forward-compat)', () => {
    expect(
      normalizeInstanceConfig({
        future_field: 'foo',
        max_attachment_bytes: 42,
      }),
    ).toMatchObject({
      future_field: 'foo',
      max_attachment_bytes: 42,
      maxAttachmentBytes: 42,
    });
  });

  it('returns an empty object for non-object input', () => {
    expect(normalizeInstanceConfig(null)).toEqual({});
    expect(normalizeInstanceConfig(undefined)).toEqual({});
    expect(normalizeInstanceConfig('garbage')).toEqual({});
  });
});

describe('cache helpers', () => {
  let qc;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('seedInstanceConfigQuery writes a normalized snapshot under the instance key', () => {
    seedInstanceConfigQuery(qc, INSTANCE_A, {
      name: 'Hush',
      maxAttachmentBytes: 99,
      type: 'should-not-leak',
    });
    expect(qc.getQueryData(instanceConfigQueryKey(INSTANCE_A))).toEqual({
      name: 'Hush',
      maxAttachmentBytes: 99,
      max_attachment_bytes: 99,
    });
  });

  it('mergeInstanceConfigUpdate merges into the existing cached value', () => {
    seedInstanceConfigQuery(qc, INSTANCE_A, { name: 'Hush' });
    mergeInstanceConfigUpdate(qc, INSTANCE_A, {
      type: 'instance_updated',
      max_attachment_bytes: 1234,
      registrationMode: 'invite_only',
    });
    expect(qc.getQueryData(instanceConfigQueryKey(INSTANCE_A))).toEqual({
      name: 'Hush',
      max_attachment_bytes: 1234,
      maxAttachmentBytes: 1234,
      registrationMode: 'invite_only',
      registration_mode: 'invite_only',
    });
  });

  it('mergeInstanceConfigUpdate strips type from the cache, not just from the merged return value', () => {
    seedInstanceConfigQuery(qc, INSTANCE_A, { name: 'Hush' });
    mergeInstanceConfigUpdate(qc, INSTANCE_A, {
      type: 'instance_updated',
      max_attachment_bytes: 9999,
    });
    const cached = qc.getQueryData(instanceConfigQueryKey(INSTANCE_A));
    expect(cached.type).toBeUndefined();
    expect(cached.max_attachment_bytes).toBe(9999);
  });

  it('mergeInstanceConfigUpdate ignores null/undefined payload fields', () => {
    seedInstanceConfigQuery(qc, INSTANCE_A, {
      max_attachment_bytes: 7,
      name: 'Hush',
    });
    mergeInstanceConfigUpdate(qc, INSTANCE_A, {
      max_attachment_bytes: null,
      name: undefined,
      registrationMode: 'open',
    });
    expect(qc.getQueryData(instanceConfigQueryKey(INSTANCE_A))).toMatchObject({
      max_attachment_bytes: 7,
      maxAttachmentBytes: 7,
      name: 'Hush',
      registrationMode: 'open',
    });
  });

  it('mergeInstanceConfigUpdate does not touch other instances', () => {
    seedInstanceConfigQuery(qc, INSTANCE_A, { max_attachment_bytes: 1 });
    seedInstanceConfigQuery(qc, INSTANCE_B, { max_attachment_bytes: 2 });

    mergeInstanceConfigUpdate(qc, INSTANCE_A, {
      type: 'instance_updated',
      max_attachment_bytes: 100,
    });

    expect(qc.getQueryData(instanceConfigQueryKey(INSTANCE_A))).toMatchObject({
      max_attachment_bytes: 100,
    });
    expect(qc.getQueryData(instanceConfigQueryKey(INSTANCE_B))).toMatchObject({
      max_attachment_bytes: 2,
    });
  });

  it('mergeInstanceConfigUpdate seeds the cache when the entry does not yet exist', () => {
    expect(qc.getQueryData(instanceConfigQueryKey(INSTANCE_A))).toBeUndefined();
    mergeInstanceConfigUpdate(qc, INSTANCE_A, {
      type: 'instance_updated',
      max_attachment_bytes: 5,
    });
    expect(qc.getQueryData(instanceConfigQueryKey(INSTANCE_A))).toMatchObject({
      max_attachment_bytes: 5,
      maxAttachmentBytes: 5,
    });
  });

  it('mergeInstanceConfigUpdate returns null for a structurally invalid payload', () => {
    expect(mergeInstanceConfigUpdate(qc, INSTANCE_A, null)).toBeNull();
    expect(mergeInstanceConfigUpdate(qc, INSTANCE_A, undefined)).toBeNull();
    expect(mergeInstanceConfigUpdate(qc, INSTANCE_A, 'garbage')).toBeNull();
  });

  it('removeInstanceConfigQuery clears the matching instance entry only', () => {
    seedInstanceConfigQuery(qc, INSTANCE_A, { max_attachment_bytes: 1 });
    seedInstanceConfigQuery(qc, INSTANCE_B, { max_attachment_bytes: 2 });

    removeInstanceConfigQuery(qc, INSTANCE_A);

    expect(qc.getQueryData(instanceConfigQueryKey(INSTANCE_A))).toBeUndefined();
    expect(qc.getQueryData(instanceConfigQueryKey(INSTANCE_B))).toMatchObject({
      max_attachment_bytes: 2,
    });
  });
});
