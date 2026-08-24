import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type Configuration,
} from '@azure/msal-browser';
import { setAuthTokenGetter } from '@workspace/api-client-react';

/**
 * Microsoft Entra ID sign-in for the browser.
 *
 * The tenant details are not baked into this bundle at build time: the API
 * publishes them from `/api/auth/config`, so the same build works against any
 * environment. When the tenant is not configured the app is left on password
 * sign-in and nothing here activates.
 */

export interface EntraSettings {
  tenantId: string;
  clientId: string | null;
  scope: string | null;
}

export interface AuthConfig {
  /** False once ENTRA_ONLY retires passwords server-side. */
  passwordSignIn: boolean;
  entra: EntraSettings | null;
}

// Assume passwords until the server says otherwise, so a failed config fetch
// degrades to the login that has always worked rather than to no login at all.
let authConfig: AuthConfig = { passwordSignIn: true, entra: null };
let msal: PublicClientApplication | null = null;
let scopes: string[] = [];

export function getAuthConfig(): AuthConfig {
  return authConfig;
}

export function isEntraEnabled(): boolean {
  return msal !== null;
}

async function fetchAuthConfig(): Promise<AuthConfig> {
  const response = await fetch('/api/auth/config', {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`/api/auth/config responded ${response.status}`);
  }
  return (await response.json()) as AuthConfig;
}

/**
 * Resolves how sign-in works and prepares MSAL when Entra is configured.
 *
 * Runs once before the app renders, because the bearer-token getter has to be
 * registered before the first API call: otherwise an already-signed-in user
 * looks anonymous on the initial `/users/me` and gets bounced to the login
 * screen.
 */
export async function initAuth(): Promise<AuthConfig> {
  try {
    authConfig = await fetchAuthConfig();
  } catch {
    // Offline, or an API too old to publish the endpoint.
    return authConfig;
  }

  const entra = authConfig.entra;
  if (!entra?.clientId || !entra.scope) {
    return authConfig;
  }

  scopes = [entra.scope];

  const configuration: Configuration = {
    auth: {
      clientId: entra.clientId,
      authority: `https://login.microsoftonline.com/${entra.tenantId}`,
      // A near-empty page, not the application root. Pointing this at the root
      // makes the popup load the whole SPA and show a second login screen
      // inside itself instead of closing. Must be registered as a SPA redirect
      // URI in Entra exactly as it is built here.
      redirectUri: `${window.location.origin}/blank.html`,
    },
    cache: {
      // Not localStorage: tokens should not outlive the browser session.
      cacheLocation: 'sessionStorage',
    },
  };

  const instance = new PublicClientApplication(configuration);
  await instance.initialize();
  // Completes the handshake when we arrived back from a redirect sign-in.
  await instance.handleRedirectPromise();

  const [existing] = instance.getAllAccounts();
  if (existing) {
    instance.setActiveAccount(existing);
  }

  msal = instance;
  setAuthTokenGetter(() => getAccessToken());

  return authConfig;
}

/**
 * Returns a token for the API, or null when nobody is signed in through Entra.
 *
 * Null rather than an interactive prompt on purpose: a popup appearing behind
 * an unrelated background request is worse than a 401 that sends the user to
 * the login screen deliberately.
 */
export async function getAccessToken(): Promise<string | null> {
  if (!msal) return null;

  const account = msal.getActiveAccount() ?? msal.getAllAccounts()[0];
  if (!account) return null;

  try {
    const result = await msal.acquireTokenSilent({ account, scopes });
    return result.accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      return null;
    }
    throw error;
  }
}

export async function signInWithMicrosoft(): Promise<void> {
  if (!msal) {
    throw new Error('Microsoft sign-in is not configured for this environment');
  }

  const result = await msal.loginPopup({ scopes });
  msal.setActiveAccount(result.account);
}

/** Clears the Microsoft session too, so the next sign-in re-prompts. */
export async function signOutFromMicrosoft(): Promise<void> {
  if (!msal) return;

  const account = msal.getActiveAccount();
  if (!account) return;

  await msal.logoutPopup({ account });
}
