import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

export interface ClaudeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

function getUsername(): string {
  try {
    return process.env.USER || os.userInfo().username;
  } catch {
    return 'claude-code-user';
  }
}

function readFromKeychain(): ClaudeCredentials | null {
  if (process.platform !== 'darwin') return null;
  try {
    const username = getUsername();
    const raw = execSync(
      `security find-generic-password -a "${username}" -w -s "${KEYCHAIN_SERVICE}"`,
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
      .toString()
      .trim();
    if (!raw) return null;
    const data = JSON.parse(raw);
    const oauth = data.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken ?? '',
      expiresAt: oauth.expiresAt ?? 0,
    };
  } catch {
    return null;
  }
}

function readFromFile(): ClaudeCredentials | null {
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const raw = fs.readFileSync(credPath, 'utf-8');
    const data = JSON.parse(raw);
    const oauth = data.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken ?? '',
      expiresAt: oauth.expiresAt ?? 0,
    };
  } catch {
    return null;
  }
}

export function readCredentials(): ClaudeCredentials | null {
  // Prefer keychain (macOS) — it's always up to date
  return readFromKeychain() ?? readFromFile();
}

/** Returns true if the token expires within the next 5 minutes */
export function isTokenExpiredOrExpiringSoon(creds: ClaudeCredentials): boolean {
  return creds.expiresAt - Date.now() < 5 * 60 * 1000;
}

/** Refresh the OAuth token. Returns new credentials or null on failure. */
export async function refreshToken(
  creds: ClaudeCredentials
): Promise<ClaudeCredentials | null> {
  if (!creds.refreshToken) return null;
  try {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: CLIENT_ID,
      scope: 'user:inference user:profile user:sessions:claude_code',
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // @ts-ignore — Node 18+ fetch signal
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) return null;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? creds.refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : 0,
    };
  } catch {
    return null;
  }
}
