import * as vscode from "vscode";
import fetch from "node-fetch";

type Stored = {
  idToken: string;
  refreshToken: string;
  idTokenExpiresAt: number; // epoch ms
};

const KEY = {
  REFRESH_TOKEN: "saralflow.firebase.refreshToken",
  ID_TOKEN: "saralflow.firebase.idToken",
  ID_TOKEN_EXP: "saralflow.firebase.idTokenExpiresAt",
};

export class FirebaseAuthManager {
  constructor(private apiKey: string, private secrets: vscode.SecretStorage) {}

  private memory: Stored | null = null;
  private refreshInFlight: Promise<string> | null = null;

  async loadFromSecrets() {
    const [idToken, refreshToken, expStr] = await Promise.all([
      this.secrets.get(KEY.ID_TOKEN),
      this.secrets.get(KEY.REFRESH_TOKEN),
      this.secrets.get(KEY.ID_TOKEN_EXP),
    ]);
    if (refreshToken) {
      this.memory = {
        idToken: idToken || "",
        refreshToken,
        idTokenExpiresAt: Number(expStr || "0"),
      };
    }
  }

  /** Called once when webview sends the initial tokens */
  async bootstrapFromWebview(idToken: string, refreshToken: string, expiresAtISO?: string) {
    const expMs = expiresAtISO ? Date.parse(expiresAtISO) : Date.now() + 50 * 60 * 1000;
    await this.setTokens(idToken, refreshToken, expMs);
  }

  async signOut() {
    this.refreshInFlight = null;
    this.memory = null;
    await Promise.all([
      this.secrets.delete(KEY.REFRESH_TOKEN),
      this.secrets.delete(KEY.ID_TOKEN),
      this.secrets.delete(KEY.ID_TOKEN_EXP),
    ]);
  }

  /** Get a valid ID token; auto-refreshes using refresh token if needed */
  async getIdToken(): Promise<string> {
    if (!this.memory) {await this.loadFromSecrets();}
    if (!this.memory) {throw new Error("Not signed in.");}

    const now = Date.now();
    // refresh if expires in ≤ 2 minutes or missing
    if (!this.memory.idToken || this.memory.idTokenExpiresAt - now <= 2 * 60 * 1000) {
      return this.refreshIdToken();
    }
    return this.memory.idToken;
  }

  private async refreshIdToken(): Promise<string> {
    if (this.refreshInFlight) {return this.refreshInFlight;}
    if (!this.memory?.refreshToken) {throw new Error("No refresh token.");}

    this.refreshInFlight = (async () => {
      const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${this.apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: this.memory!.refreshToken,
        }),
      });
      if (!r.ok) {
        await this.signOut();
        throw new Error(`Refresh failed: ${await r.text()}`);
      }
      const { id_token, refresh_token, expires_in } = (await r.json()) as any;
      // expires_in is seconds from now; keep a buffer
      const expMs = Date.now() + (Number(expires_in) - 60) * 1000;
      await this.setTokens(id_token, refresh_token || this.memory!.refreshToken, expMs);
      return this.memory!.idToken;
    })();

    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async setTokens(idToken: string, refreshToken: string, expMs: number) {
    this.memory = { idToken, refreshToken, idTokenExpiresAt: expMs };
    await Promise.all([
      this.secrets.store(KEY.ID_TOKEN, idToken),
      this.secrets.store(KEY.REFRESH_TOKEN, refreshToken),
      this.secrets.store(KEY.ID_TOKEN_EXP, String(expMs)),
    ]);
  }

  async ensureSignedIn(): Promise<void> {
    try {
      const token = await this.getIdToken(); // will refresh if expired
      console.log('[Auth] Silent sign-in OK, token available');
    } catch (err: any) {
      console.warn('[Auth] Silent sign-in failed:', err?.message || err);
      throw err;
    }
  }
}
