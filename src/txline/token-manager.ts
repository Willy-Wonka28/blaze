import type { TokenCache } from "./types.js";

const TOKEN_BUFFER_MS = 5 * 60 * 1000;

export class TokenManager {
  private cache: TokenCache | null = null;
  private refreshPromise: Promise<{ jwt: string; apiToken: string }> | null = null;

  constructor(
    private apiOrigin: string,
    existingJwt?: string,
    existingApiToken?: string
  ) {
    if (existingJwt && existingApiToken) {
      this.cache = {
        jwt: existingJwt,
        apiToken: existingApiToken,
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      };
    }
  }

  get isExpired(): boolean {
    if (!this.cache) return true;
    return Date.now() >= this.cache.expiresAt - TOKEN_BUFFER_MS;
  }

  get credentials(): { jwt: string; apiToken: string } | null {
    if (!this.cache || this.isExpired) return null;
    return { jwt: this.cache.jwt, apiToken: this.cache.apiToken };
  }

  async getValidCredentials(): Promise<{ jwt: string; apiToken: string }> {
    const creds = this.credentials;
    if (creds) return creds;

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async refresh(): Promise<{ jwt: string; apiToken: string }> {
    const jwt = await fetch(`${this.apiOrigin}/auth/guest/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }).then((r) => {
      if (!r.ok) throw new Error(`Guest session failed: ${r.status}`);
      return r.json() as Promise<{ token: string }>;
    });

    this.cache = {
      jwt: jwt.token,
      apiToken: this.cache?.apiToken ?? "",
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    };

    return { jwt: jwt.token, apiToken: this.cache.apiToken };
  }

  setApiToken(apiToken: string): void {
    if (this.cache) {
      this.cache.apiToken = apiToken;
    }
  }

  setCredentials(jwt: string, apiToken: string): void {
    this.cache = {
      jwt,
      apiToken,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    };
  }
}
