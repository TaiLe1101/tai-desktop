import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INCREMENTAL_FLUSH_INTERVAL_MS, PlaybackClock } from '../src/shared/alignment-policy';
import {
  DubbingAuthOrQuotaError,
  computeQuotaPercent,
  decodeBlockError,
  encodeBlockError,
  extractMeProfileAndEntitlement,
  extractResponseData,
  formatDubbingBlockMessage,
  formatQuotaLabel,
  formatVnd,
  parseDubbingBlockError
} from '../src/shared/saas';
import type { QuotaDto } from '../src/shared/types';

describe('SaaS auth & quota error parsing', () => {
  it('parses 401/402/403 block responses into typed DubbingAuthOrQuotaError', () => {
    const quota: QuotaDto = {
      period: '2026-11',
      usedSeconds: 3600,
      usedMinutes: 60,
      limitMinutes: 60,
      remainingMinutes: 0,
      isUnlimited: false,
      canDub: false,
      blockReason: 'QUOTA_EXCEEDED'
    };

    const e401 = parseDubbingBlockError(401, { code: 'AUTH_REQUIRED', message: 'Unauthorized' });
    assert.ok(e401 instanceof DubbingAuthOrQuotaError);
    assert.equal(e401.code, 'AUTH_REQUIRED');
    assert.equal(e401.statusCode, 401);

    const e402Quota = parseDubbingBlockError(402, { code: 'QUOTA_EXCEEDED', message: 'Hết hạn mức', quota });
    assert.ok(e402Quota instanceof DubbingAuthOrQuotaError);
    assert.equal(e402Quota.code, 'QUOTA_EXCEEDED');
    assert.equal(e402Quota.quota?.usedMinutes, 60);

    const e402Exp = parseDubbingBlockError(402, { code: 'SUBSCRIPTION_EXPIRED' });
    assert.equal(e402Exp?.code, 'SUBSCRIPTION_EXPIRED');

    const e402NoSub = parseDubbingBlockError(402, { code: 'NO_SUBSCRIPTION' });
    assert.equal(e402NoSub?.code, 'NO_SUBSCRIPTION');

    const e403Susp = parseDubbingBlockError(403, { code: 'TENANT_SUSPENDED' });
    assert.equal(e403Susp?.code, 'TENANT_SUSPENDED');

    // Non-block 403 (e.g. INVALID_TTS_SIGNATURE) must return null so it is NOT misclassified
    assert.equal(parseDubbingBlockError(403, { code: 'INVALID_TTS_SIGNATURE' }), null);
    assert.equal(parseDubbingBlockError(500, { message: 'Internal' }), null);
  });

  it('round-trips encoded block errors across Electron IPC messages', () => {
    const encoded = encodeBlockError('QUOTA_EXCEEDED', formatDubbingBlockMessage('QUOTA_EXCEEDED'));
    const decoded = decodeBlockError(new Error(`Error invoking remote method 'tai:synthesize-tts': Error: ${encoded}`));
    assert.ok(decoded);
    assert.equal(decoded.code, 'QUOTA_EXCEEDED');
    assert.ok(decoded.message.includes('hạn mức'));
    assert.equal(decodeBlockError(new Error('Normal network timeout')), null);
  });
});

describe('SaaS quota formatting & envelope helpers', () => {
  it('computes quota percent and Vietnamese labels accurately', () => {
    const limited: QuotaDto = {
      period: '2026-11',
      usedSeconds: 1800,
      usedMinutes: 30,
      limitMinutes: 60,
      remainingMinutes: 30,
      isUnlimited: false,
      canDub: true,
      blockReason: null
    };
    assert.equal(computeQuotaPercent(limited), 50);
    assert.equal(formatQuotaLabel(limited), '30 / 60 phút');

    const unlimited: QuotaDto = {
      ...limited,
      limitMinutes: null,
      remainingMinutes: null,
      isUnlimited: true
    };
    assert.equal(computeQuotaPercent(unlimited), 0);
    assert.ok(formatQuotaLabel(unlimited).includes('Không giới hạn'));

    assert.equal(formatVnd(0), 'Miễn phí');
    assert.ok(formatVnd(99000).includes('99') && formatVnd(99000).endsWith('đ'));
  });

  it('unwraps ResponseApi envelopes and throws on error status', () => {
    const data = extractResponseData<{ ok: boolean }>({ statusCode: 200, status: 'success', data: { ok: true } });
    assert.deepEqual(data, { ok: true });
    assert.throws(
      () => extractResponseData({ statusCode: 400, status: 'error', message: 'Email đã tồn tại' }),
      /Email đã tồn tại/
    );
  });

  it('unwraps /api/v1/auth/me nested { profile, entitlement } and flat shapes', () => {
    const nested = extractMeProfileAndEntitlement({
      profile: {
        id: 7,
        username: 'alice@example.com',
        email: 'alice@example.com',
        firstName: 'Alice',
        lastName: 'Nguyen',
        isRoot: false
      },
      roles: ['USER'],
      permissions: [],
      entitlement: { tenant: { id: 1, name: 'Alice Workspace' } }
    });
    assert.equal(nested.user.id, 7);
    assert.equal(nested.user.username, 'alice@example.com');
    assert.equal(nested.user.email, 'alice@example.com');
    assert.equal(nested.user.firstName, 'Alice');
    assert.equal(nested.user.lastName, 'Nguyen');
    assert.equal(nested.user.isRoot, false);
    assert.equal(nested.entitlement?.tenant.name, 'Alice Workspace');

    const flat = extractMeProfileAndEntitlement({
      id: 9,
      username: 'bob',
      email: null,
      firstName: 'Bob',
      lastName: 'Tran'
    });
    assert.equal(flat.user.id, 9);
    assert.equal(flat.user.firstName, 'Bob');
    assert.equal(flat.entitlement, null);
  });
});

describe('PlaybackClock incremental 30s delta flush', () => {
  it('exports 30s interval and consumes/restores incremental deltas without double-counting', () => {
    assert.equal(INCREMENTAL_FLUSH_INTERVAL_MS, 30_000);
    const clock = new PlaybackClock();
    for (let t = 0; t <= 30; t += 1) {
      clock.tick(t, true);
    }
    assert.equal(clock.watchedSeconds, 30);
    assert.equal(clock.pendingDeltaSeconds, 30);

    // First 30s incremental flush
    const d1 = clock.consumeDelta();
    assert.equal(d1, 30);
    assert.equal(clock.pendingDeltaSeconds, 0);
    assert.equal(clock.watchedSeconds, 30);

    // Advance 12 more seconds
    for (let t = 31; t <= 42; t += 1) {
      clock.tick(t, true);
    }
    assert.equal(clock.watchedSeconds, 42);
    assert.equal(clock.pendingDeltaSeconds, 12);

    // Simulate failed flush -> restoreDelta preserves exact 12s
    const d2 = clock.consumeDelta();
    assert.equal(d2, 12);
    assert.equal(clock.pendingDeltaSeconds, 0);
    clock.restoreDelta(d2);
    assert.equal(clock.pendingDeltaSeconds, 12);

    // Final stop flush consumes only the remaining 12s (total reported = 30 + 12 = 42s)
    const d3 = clock.consumeDelta();
    assert.equal(d3, 12);
    assert.equal(clock.pendingDeltaSeconds, 0);
  });
});
