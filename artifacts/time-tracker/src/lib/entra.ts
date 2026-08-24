import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type Configuration,
} from '@azure/msal-browser';
import { setAuthTokenGetter } from '@workspace/api-client-react';
import { reportError } from './error-reporting';

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
let lastSignInError: string | null = null;

export function getAuthConfig(): AuthConfig {
  return authConfig;
}

export function isEntraEnabled(): boolean {
  return msal !== null;
}

/**
 * Why the last sign-in attempt failed, or null.
 *
 * Entra reports a refusal - an unassigned account, a blocked app - on the
 * return leg of the redirect rather than to the caller, so without this the
 * reason is thrown away and the user is returned to the login screen with no
 * explanation.
 */
export function getSignInError(): string | null {
  return lastSignInError;
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
      // Redirect flow returns to the app itself, which loads and completes the
      // handshake in initAuth below. Registered as a SPA redirect URI in Entra.
      redirectUri: window.location.origin,
    },
    cache: {
      // Not localStorage: tokens should not outlive the browser session.
      cacheLocation: 'sessionStorage',
    },
  };

  const instance = new PublicClientApplication(configuration);

  try {
    await instance.initialize();

    // Completes the handshake when this load is the return leg of a redirect
    // sign-in. Returns null on an ordinary load, which is not an error.
    const redirectResult = await instance.handleRedirectPromise();

    // Temporary trace for the rollout: a valid token has been confirmed to
    // come back from Microsoft while the API never receives one, so the gap
    // is somewhere in this function or getAccessToken. Remove once resolved.
    console.log('[entra-debug] handleRedirectPromise resolved', {
      hasRedirectResult: redirectResult !== null,
      redirectAccountUpn: redirectResult?.account?.username ?? null,
      cachedAccountCount: instance.getAllAccounts().length,
    });

    const account = redirectResult?.account ?? instance.getAllAccounts()[0];
    if (account) {
      instance.setActiveAccount(account);
    }
    console.log('[entra-debug] active account after initAuth', {
      username: account?.username ?? null,
    });
  } catch (error: any) {
    console.log('[entra-debug] handleRedirectPromise threw', {
      name: error?.name,
      errorCode: error?.errorCode,
      message: error?.errorMessage || error?.message,
    });
    // A refused sign-in throws here on the way back. Record it and carry on:
    // letting it escape leaves msal unassigned, which hides the Microsoft
    // button altogether, so one failure would remove any way to retry.
    lastSignInError =
      error?.errorMessage || error?.message || String(error);
    // The only place this specific failure - the actual reason Entra refused
    // the sign-in - can be captured. It is caught here on purpose, so it never
    // reaches window.onerror or triggers an unhandledrejection.
    reportError(error, { kind: 'msal-redirect-handling' });
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
  if (!msal) {
    console.log('[entra-debug] getAccessToken: msal not initialized');
    return null;
  }

  const account = msal.getActiveAccount() ?? msal.getAllAccounts()[0];
  if (!account) {
    console.log('[entra-debug] getAccessToken: no account available');
    return null;
  }

  try {
    const result = await msal.acquireTokenSilent({ account, scopes });
    console.log('[entra-debug] acquireTokenSilent succeeded', {
      tokenLength: result.accessToken.length,
      scopes: result.scopes,
    });
    return result.accessToken;
  } catch (error: any) {
    console.log('[entra-debug] acquireTokenSilent threw', {
      name: error?.name,
      errorCode: error?.errorCode,
      message: error?.errorMessage || error?.message,
      isInteractionRequired: error instanceof InteractionRequiredAuthError,
    });
    if (error instanceof InteractionRequiredAuthError) {
      return null;
    }
    // Rethrown into customFetch, which has no try/catch around this call, so
    // it propagates into whichever query triggered it - React Query treats
    // that as a query error rather than an unhandledrejection, and it would
    // otherwise vanish. Reported here since this is the last point that sees
    // the real error object.
    reportError(error, { kind: 'msal-acquire-token-silent' });
    throw error;
  }
}

/**
 * Starts sign-in by navigating this window to Microsoft.
 *
 * Redirect rather than popup: a popup only works when the opener can watch the
 * window it opened. Opened from Teams or Outlook, or with a popup blocker in
 * the way, the opener cannot, and sign-in hangs on a blank window that never
 * closes. Navigating the top window has none of those failure modes.
 *
 * The returned promise does not resolve - the page is being navigated away.
 */
export async function signInWithMicrosoft(): Promise<void> {
  if (!msal) {
    throw new Error('Microsoft sign-in is not configured for this environment');
  }

  await msal.loginRedirect({ scopes });
}

/** Clears the Microsoft session too, so the next sign-in re-prompts. */
export async function signOutFromMicrosoft(): Promise<void> {
  if (!msal) return;

  const account = msal.getActiveAccount();
  if (!account) return;

  await msal.logoutRedirect({ account });
}
