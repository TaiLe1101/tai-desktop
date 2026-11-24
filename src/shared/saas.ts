import type { DubbingBlockCode, EntitlementDto, QuotaDto, UserSummary } from './types';

export const DUBBING_BLOCK_CODES = new Set<DubbingBlockCode>([
  'AUTH_REQUIRED',
  'QUOTA_EXCEEDED',
  'SUBSCRIPTION_EXPIRED',
  'NO_SUBSCRIPTION',
  'TENANT_SUSPENDED'
]);

export function isDubbingBlockCode(value: unknown): value is DubbingBlockCode {
  return typeof value === 'string' && DUBBING_BLOCK_CODES.has(value as DubbingBlockCode);
}

export function formatDubbingBlockMessage(code: DubbingBlockCode, serverMessage?: string): string {
  if (serverMessage && serverMessage.trim() && !/^(Unauthorized|Forbidden|Payment Required)$/i.test(serverMessage.trim())) {
    return serverMessage.trim();
  }
  switch (code) {
    case 'AUTH_REQUIRED':
      return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại để tiếp tục sử dụng.';
    case 'QUOTA_EXCEEDED':
      return 'Bạn đã sử dụng hết hạn mức phút lồng tiếng trong tháng này. Hãy nâng cấp gói để tiếp tục.';
    case 'SUBSCRIPTION_EXPIRED':
      return 'Gói dịch vụ của bạn đã hết hạn. Vui lòng gia hạn hoặc nâng cấp gói để tiếp tục lồng tiếng.';
    case 'NO_SUBSCRIPTION':
      return 'Tài khoản chưa có gói dịch vụ hoạt động. Vui lòng nâng cấp gói hoặc liên hệ quản trị viên.';
    case 'TENANT_SUSPENDED':
      return 'Không gian làm việc của bạn đang tạm khóa. Vui lòng liên hệ quản trị viên để được hỗ trợ.';
  }
}

export class DubbingAuthOrQuotaError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: DubbingBlockCode,
    message?: string,
    public readonly quota?: QuotaDto
  ) {
    super(formatDubbingBlockMessage(code, message));
    this.name = 'DubbingAuthOrQuotaError';
  }
}

const BLOCK_TAG_PREFIX = '[TAI_BLOCK:';

export function encodeBlockError(code: DubbingBlockCode, message: string): string {
  return `${BLOCK_TAG_PREFIX}${code}] ${message}`;
}

export function decodeBlockError(raw: unknown): { code: DubbingBlockCode; message: string } | null {
  const text = raw instanceof Error ? raw.message : String(raw || '');
  const match = text.match(/\[TAI_BLOCK:([A-Z_]+)\]\s*([\s\S]*)$/);
  if (!match) return null;
  const code = match[1];
  if (!isDubbingBlockCode(code)) return null;
  return {
    code,
    message: match[2]?.trim() || formatDubbingBlockMessage(code)
  };
}

/**
 * Parses `401 AUTH_REQUIRED`, `402 QUOTA_EXCEEDED | SUBSCRIPTION_EXPIRED | NO_SUBSCRIPTION`,
 * or `403 TENANT_SUSPENDED` responses from `/api/v1/dubbing/*` into a typed `DubbingAuthOrQuotaError`.
 */
export function parseDubbingBlockError(status: number, body: unknown): DubbingAuthOrQuotaError | null {
  const payload = (body && typeof body === 'object' ? body : {}) as {
    code?: unknown;
    message?: unknown;
    quota?: QuotaDto;
  };
  const msg = typeof payload.message === 'string' ? payload.message : undefined;
  const quota = payload.quota && typeof payload.quota === 'object' ? payload.quota : undefined;

  if (isDubbingBlockCode(payload.code)) {
    return new DubbingAuthOrQuotaError(status, payload.code, msg, quota);
  }
  if (status === 401) {
    return new DubbingAuthOrQuotaError(401, 'AUTH_REQUIRED', msg, quota);
  }
  if (status === 402) {
    return new DubbingAuthOrQuotaError(402, 'QUOTA_EXCEEDED', msg, quota);
  }
  if (status === 403 && payload.code === 'TENANT_SUSPENDED') {
    return new DubbingAuthOrQuotaError(403, 'TENANT_SUSPENDED', msg, quota);
  }
  return null;
}

export interface ResponseApiEnvelope<T> {
  statusCode?: number;
  status?: 'success' | 'error';
  message?: string;
  data?: T;
}

export function extractResponseData<T>(payload: unknown, fallbackError = 'Yêu cầu thất bại.'): T {
  if (!payload || typeof payload !== 'object') {
    throw new Error(fallbackError);
  }
  const env = payload as ResponseApiEnvelope<T>;
  if (env.status === 'error') {
    throw new Error(env.message || fallbackError);
  }
  if ('data' in env && env.data !== undefined) {
    return env.data as T;
  }
  return payload as T;
}

export function computeQuotaPercent(quota: QuotaDto | null | undefined): number {
  if (!quota || quota.isUnlimited || quota.limitMinutes === null || quota.limitMinutes <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((quota.usedMinutes / quota.limitMinutes) * 100)));
}

export function formatQuotaLabel(quota: QuotaDto | null | undefined): string {
  if (!quota) return '—';
  if (quota.isUnlimited || quota.limitMinutes === null) {
    return `${Math.round(quota.usedMinutes)} phút · Không giới hạn`;
  }
  const used = quota.usedMinutes < 10 ? Math.round(quota.usedMinutes * 10) / 10 : Math.round(quota.usedMinutes);
  return `${used} / ${quota.limitMinutes} phút`;
}

export function formatVnd(amount: number, currency = 'VND'): string {
  if (!Number.isFinite(amount) || amount <= 0) return 'Miễn phí';
  if (currency.toUpperCase() === 'VND') {
    return `${Math.round(amount).toLocaleString('vi-VN')}đ`;
  }
  return `${amount.toLocaleString('en-US')} ${currency}`;
}

/**
 * Unwraps `/api/v1/auth/me` response data supporting both nested
 * `{ profile: UserSummary, entitlement }` (tai-be canonical shape) and flat `UserSummary`.
 */
export function extractMeProfileAndEntitlement(raw: unknown): {
  user: UserSummary;
  entitlement: EntitlementDto | null;
} {
  const payload = (raw && typeof raw === 'object' ? raw : {}) as {
    profile?: Partial<UserSummary>;
    entitlement?: EntitlementDto | null;
  } & Partial<UserSummary>;
  const src = payload.profile && typeof payload.profile === 'object' ? payload.profile : payload;
  return {
    user: {
      id: Number(src.id) || 0,
      username: typeof src.username === 'string' ? src.username : '',
      email: typeof src.email === 'string' ? src.email : null,
      firstName: typeof src.firstName === 'string' ? src.firstName : '',
      lastName: typeof src.lastName === 'string' ? src.lastName : '',
      ...(typeof src.isRoot === 'boolean' ? { isRoot: src.isRoot } : {})
    },
    entitlement: payload.entitlement ?? null
  };
}
