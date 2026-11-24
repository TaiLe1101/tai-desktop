import { BrowserWindow, net } from 'electron';
import { extractMeProfileAndEntitlement, extractResponseData } from '../shared/saas';
import type {
  AuthLoginInput,
  AuthRegisterInput,
  AuthState,
  CreateUpgradeRequestInput,
  EntitlementDto,
  PlanDto,
  QuotaDto,
  UpgradeRequestDto,
  UserSummary
} from '../shared/types';
import type { SettingsStore } from './settings';

const AUTH_TIMEOUT_MS = 15_000;

function normalizeOrigin(urlStr: string): string {
  try {
    return new URL(urlStr).origin;
  } catch {
    return '';
  }
}

export class AuthService {
  private window: BrowserWindow | null = null;
  private accessToken = '';
  private refreshToken = '';
  private state: AuthState = {
    authenticated: false,
    user: null,
    entitlement: null
  };
  private refreshInFlight: Promise<string | null> | null = null;

  constructor(private readonly settings: SettingsStore) {}

  setWindow(win: BrowserWindow): void {
    this.window = win;
  }

  getState(): AuthState {
    return { ...this.state };
  }

  getAccessToken(): string {
    return this.accessToken;
  }

  private emitState(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('tai:auth-state-changed', this.getState());
    }
  }

  private serverUrl(): string {
    const url = this.settings.server().serverUrl;
    if (!url) throw new Error('Chưa cấu hình địa chỉ máy chủ (SERVER_URL).');
    return url;
  }

  /**
   * Origin-isolated request to SERVER_URL: attaches Authorization Bearer token
   * ONLY when resolved target origin strictly equals SERVER_URL origin.
   */
  private async serverFetch(
    path: string,
    init: RequestInit = {},
    options: { requireAuth?: boolean; tokenOverride?: string } = {}
  ): Promise<Response> {
    const baseUrl = this.serverUrl();
    const baseOrigin = normalizeOrigin(baseUrl);
    if (!baseOrigin) throw new Error('SERVER_URL không hợp lệ.');

    const targetUrl = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
    const targetOrigin = normalizeOrigin(targetUrl);

    const headers = new Headers(init.headers || {});
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    const token = options.tokenOverride ?? this.accessToken;
    if (options.requireAuth && targetOrigin === baseOrigin && token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
    try {
      return await net.fetch(targetUrl, {
        ...init,
        headers,
        redirect: 'error',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Authenticated JSON fetch with single automatic 401 refresh + retry.
   */
  private async authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.accessToken) {
      const refreshed = await this.refreshSession();
      if (!refreshed) throw new Error('Vui lòng đăng nhập để tiếp tục.');
    }

    let res = await this.serverFetch(path, init, { requireAuth: true });
    if (res.status === 401) {
      const nextToken = await this.refreshSession();
      if (!nextToken) {
        throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      }
      res = await this.serverFetch(path, init, { requireAuth: true, tokenOverride: nextToken });
    }

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (json && typeof json === 'object' && 'message' in json && typeof (json as { message?: unknown }).message === 'string')
        ? (json as { message: string }).message
        : `Máy chủ trả lỗi HTTP ${res.status}.`;
      throw new Error(msg);
    }
    return extractResponseData<T>(json);
  }

  async init(): Promise<AuthState> {
    const stored = this.settings.getAuthTokens();
    this.accessToken = stored.accessToken;
    this.refreshToken = stored.refreshToken;
    if (!this.accessToken && !this.refreshToken) {
      this.state = { authenticated: false, user: null, entitlement: null };
      return this.getState();
    }

    try {
      const me = await this.authedJson<unknown>('/api/v1/auth/me', { method: 'GET' });
      const { user, entitlement } = extractMeProfileAndEntitlement(me);
      this.state = {
        authenticated: true,
        user,
        entitlement
      };
      if (!this.state.entitlement) {
        await this.getEntitlement().catch(() => null);
      }
    } catch {
      // Token invalid or server unreachable while validating; if tokens were cleared by refreshSession, stay logged out
      if (!this.accessToken && !this.refreshToken) {
        this.state = { authenticated: false, user: null, entitlement: null };
      }
    }
    this.emitState();
    return this.getState();
  }

  async login(input: AuthLoginInput): Promise<AuthState> {
    const username = (input.username || '').trim();
    const password = input.password || '';
    if (!username || !password) {
      throw new Error('Vui lòng nhập email/tên đăng nhập và mật khẩu.');
    }

    const res = await this.serverFetch('/api/v1/auth/app/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (json && typeof json === 'object' && 'message' in json && typeof (json as { message?: unknown }).message === 'string')
        ? (json as { message: string }).message
        : `Đăng nhập thất bại (HTTP ${res.status}).`;
      throw new Error(msg);
    }

    const data = extractResponseData<{
      accessToken: string;
      refreshToken: string;
      user: UserSummary;
      entitlement?: EntitlementDto | null;
    }>(json, 'Đăng nhập thất bại.');

    this.accessToken = data.accessToken;
    this.refreshToken = data.refreshToken;
    await this.settings.setAuthTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });

    this.state = {
      authenticated: true,
      user: data.user,
      entitlement: data.entitlement ?? null
    };
    if (!this.state.entitlement) {
      await this.getEntitlement().catch(() => null);
    }
    this.emitState();
    return this.getState();
  }

  async register(input: AuthRegisterInput): Promise<AuthState> {
    const email = (input.email || '').trim().toLowerCase();
    const firstName = (input.firstName || '').trim();
    const lastName = (input.lastName || '').trim();
    const password = input.password || '';
    const tenantName = (input.tenantName || '').trim();

    if (!email || !password || !firstName) {
      throw new Error('Vui lòng nhập đầy đủ Tên, Email và Mật khẩu.');
    }

    const res = await this.serverFetch('/api/v1/auth/app/register', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        firstName,
        ...(lastName ? { lastName } : {}),
        ...(input.username?.trim() ? { username: input.username.trim() } : {}),
        ...(tenantName ? { tenantName } : {})
      })
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (json && typeof json === 'object' && 'message' in json && typeof (json as { message?: unknown }).message === 'string')
        ? (json as { message: string }).message
        : `Đăng ký thất bại (HTTP ${res.status}).`;
      throw new Error(msg);
    }

    const data = extractResponseData<{
      accessToken: string;
      refreshToken: string;
      user: UserSummary;
      entitlement?: EntitlementDto | null;
    }>(json, 'Đăng ký thất bại.');

    this.accessToken = data.accessToken;
    this.refreshToken = data.refreshToken;
    await this.settings.setAuthTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });

    this.state = {
      authenticated: true,
      user: data.user,
      entitlement: data.entitlement ?? null
    };
    this.emitState();
    return this.getState();
  }

  /**
   * Single-flight token refresh. Clears stored credentials and notifies renderer if refresh fails.
   */
  async refreshSession(): Promise<string | null> {
    if (this.refreshInFlight) return this.refreshInFlight;
    if (!this.refreshToken) {
      await this.markUnauthenticated('SESSION_EXPIRED');
      return null;
    }

    this.refreshInFlight = (async () => {
      try {
        const res = await this.serverFetch('/api/v1/auth/app/refresh', {
          method: 'POST',
          body: JSON.stringify({ refreshToken: this.refreshToken })
        });
        if (!res.ok) {
          await this.markUnauthenticated('SESSION_EXPIRED');
          return null;
        }
        const json = await res.json().catch(() => null);
        const data = extractResponseData<{ accessToken: string; refreshToken: string }>(json);
        if (!data?.accessToken) {
          await this.markUnauthenticated('SESSION_EXPIRED');
          return null;
        }
        this.accessToken = data.accessToken;
        if (data.refreshToken) this.refreshToken = data.refreshToken;
        await this.settings.setAuthTokens({
          accessToken: this.accessToken,
          refreshToken: this.refreshToken
        });
        return this.accessToken;
      } catch {
        return null;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  async markUnauthenticated(reason = 'AUTH_REQUIRED'): Promise<void> {
    this.accessToken = '';
    this.refreshToken = '';
    await this.settings.setAuthTokens(null).catch(() => {});
    this.state = {
      authenticated: false,
      user: null,
      entitlement: null,
      reason
    };
    this.emitState();
  }

  async logout(): Promise<void> {
    if (this.accessToken) {
      await this.serverFetch('/api/v1/auth/logout', { method: 'POST' }, { requireAuth: true }).catch(() => {});
    }
    await this.markUnauthenticated('LOGOUT');
  }

  async getEntitlement(): Promise<EntitlementDto | null> {
    const entitlement = await this.authedJson<EntitlementDto>('/api/v1/saas/me/entitlement', { method: 'GET' });
    this.state = {
      ...this.state,
      authenticated: true,
      entitlement
    };
    this.emitState();
    return entitlement;
  }

  applyQuotaUpdate(quota: QuotaDto): void {
    if (!this.state.entitlement) return;
    this.state = {
      ...this.state,
      entitlement: {
        ...this.state.entitlement,
        quota
      }
    };
    this.emitState();
  }

  async listPublicPlans(): Promise<PlanDto[]> {
    const res = await this.serverFetch('/api/v1/public/plans', { method: 'GET' });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`Không tải được danh sách gói (HTTP ${res.status}).`);
    }
    const plans = extractResponseData<PlanDto[]>(json, 'Không tải được danh sách gói.');
    return Array.isArray(plans) ? plans : [];
  }

  async listUpgradeRequests(): Promise<UpgradeRequestDto[]> {
    const list = await this.authedJson<UpgradeRequestDto[]>('/api/v1/saas/me/upgrade-requests', { method: 'GET' });
    return Array.isArray(list) ? list : [];
  }

  async createUpgradeRequest(input: CreateUpgradeRequestInput): Promise<UpgradeRequestDto> {
    return this.authedJson<UpgradeRequestDto>('/api/v1/saas/me/upgrade-requests', {
      method: 'POST',
      body: JSON.stringify({
        planId: input.planId,
        billingCycle: input.billingCycle || 'MONTHLY',
        ...(input.contactNote?.trim() ? { contactNote: input.contactNote.trim() } : {})
      })
    });
  }
}
