# Entra ID setup

What a Tristone Entra administrator needs to create before TimeTrack can use
Microsoft sign-in. Everything on the application side is already built and
tested; these are the tenant objects it expects to find.

Nothing here is destructive to the running app: until `ENTRA_TENANT_ID` and
`ENTRA_AUDIENCE` are both set, the API keeps using password sign-in exactly as
it does today.

## 1. Register the API

Azure portal → Microsoft Entra ID → App registrations → New registration.

- **Name**: `TimeTrack API`
- **Supported account types**: accounts in this organizational directory only
- No redirect URI (the API never signs anyone in itself)

Then, on the new registration:

- **Expose an API** → set the Application ID URI, e.g. `api://timetrack-api`.
  This becomes `ENTRA_AUDIENCE`.
- **Expose an API** → Add a scope named `access_as_user`, admin-consent only.
  The full value (`api://timetrack-api/access_as_user`) becomes
  `ENTRA_API_SCOPE`.

### App roles

**App roles** → Create four, all with allowed member type **Users/Groups**. The
*value* is what the API reads; the display name is what admins see.

| Display name | Value | Maps to |
|---|---|---|
| MD | `TimeTrack.MD` | Managing Director |
| AVP | `TimeTrack.AVP` | Associate Vice President |
| Associate | `TimeTrack.Associate` | Associate |
| Analyst | `TimeTrack.Analyst` | Analyst |

Someone who ends up in more than one gets the most senior — that is deliberate,
so overlapping group membership never quietly reduces access.

## 2. Register the single-page app

A second registration, because a public browser client and a protected API have
different security properties and should not share an identity.

- **Name**: `TimeTrack Web`
- **Redirect URI**: platform **Single-page application**, set to the app's URL
  (e.g. `https://timetrack.tristone-partners.com`). Add
  `http://localhost:5173` too if you want local sign-in to work.
- **API permissions** → Add a permission → My APIs → `TimeTrack API` →
  `access_as_user`, then **Grant admin consent**.

Its Application (client) ID becomes `ENTRA_SPA_CLIENT_ID`.

## 3. Groups and assignment

Create four security groups and assign each to the matching app role on
**TimeTrack API** → Enterprise application → Users and groups:

- `TimeTrack-MDs` → MD
- `TimeTrack-AVPs` → AVP
- `TimeTrack-Associates` → Associate
- `TimeTrack-Analysts` → Analyst

Then, on the enterprise application's **Properties**, set **Assignment
required** to **Yes**. Without this, anyone in the tenant can obtain a token;
with it, only group members can, and a token with no TimeTrack role is refused.

From this point on, access is managed entirely in Entra: adding someone to a
group is how they get an account, moving them between groups is how their role
changes, and removing them is how access ends. There is no separate invite step.

## 4. Configure the app

Set these on the Container App (from Key Vault in production):

```
ENTRA_TENANT_ID=<Directory (tenant) ID>
ENTRA_AUDIENCE=api://timetrack-api
ENTRA_SPA_CLIENT_ID=<TimeTrack Web application (client) ID>
ENTRA_API_SCOPE=api://timetrack-api/access_as_user
```

The API now accepts Entra tokens *and* existing passwords, so the rollout can
proceed one team at a time.

## 5. Cut over

Once everyone has signed in with Microsoft at least once, set:

```
ENTRA_ONLY=true
```

Password sign-in then returns a clear "sign in with your Microsoft account"
instead of accepting credentials. Afterwards the stored password hashes can be
dropped:

```sql
UPDATE users SET password_hash = NULL;
```

## How accounts line up

On someone's first Entra sign-in the API:

1. Looks for an existing account by Entra object id.
2. Failing that, matches on email address and adopts that account — so people
   who already have history in TimeTrack keep it, rather than getting a second,
   empty account.
3. Failing that, creates a new account from the token's name, email and role.

The Entra object id is stored from then on, so the match survives someone
changing their email or surname.

## What the API checks on every request

Signature against the tenant's published keys, issuer, audience, expiry, and
the presence of a recognised TimeTrack role. A token failing any of these is
refused with a plain `401` — the reason goes to the logs, not to the caller.

Roles come from the token, not from this app's database, so a change in Entra
takes effect on the user's next token (within an hour, or immediately if
Continuous Access Evaluation is enabled for the tenant).
