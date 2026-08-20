# Deploying TimeTrack

Everything the application runs on is declared in `infra/main.bicep`. Nothing
is clicked together in the portal, so a second environment is a parameter
change rather than a project, and anyone can read what production consists of.

## What gets created

| Resource | Purpose | Roughly |
|---|---|---|
| PostgreSQL Flexible Server (B1ms, 32 GB) | All timesheet data. Private to the VNet, no public endpoint. | $22/mo |
| Container App (0.25 vCPU / 0.5 GiB) | Serves the API and the built frontend from one image. | $9/mo |
| Container Registry (Basic) | Holds the image. | $5/mo |
| Log Analytics | Logs and alerting, capped at 0.2 GB/day. | $3-6/mo |
| Key Vault | Database connection string and session secret. | < $1/mo |
| VNet, private DNS, managed identity | Keeps the database unreachable from the internet. | ~$0.50/mo |

The budget resource raises an alert at 80% forecast and again at 100% actual.

## Before the first deploy

1. **Azure CLI**, signed in as someone who can create resources in the target
   subscription: `az login`
2. **Entra applications registered** - run `scripts/setup-entra.cmd` first. The
   deployment reads `.env.entra` for the four values it needs and refuses to
   run without them.
3. **A decision on geo-redundant backup.** It copies backups to a second region
   and must be chosen *at server creation* - it cannot be enabled afterwards.
   Off by default.

## Deploy the environment

Preview first. This changes nothing:

```powershell
cd infra
./deploy.ps1 -ResourceGroup rg-timetrack-prod -Location centralindia `
             -AlertEmail you@tristone-partners.com -WhatIf
```

Then apply by dropping `-WhatIf`. It prompts before creating anything and takes
10-15 minutes, most of it the database.

The database password and session secret are generated during the run, written
straight into Key Vault, and never printed or saved to disk. Nobody needs to
know them - the application reads them with its managed identity.

### After it finishes

The script prints the application URL. Two things remain:

1. **Add that URL as a redirect URI** on the *TimeTrack Web* app registration,
   under Authentication. Microsoft sign-in is refused until the address matches
   exactly.
2. **Publish a build.** The app starts on a placeholder image because nothing
   has been pushed to the registry yet, so it will not serve TimeTrack until
   the pipeline has run once.

## Connect GitHub Actions

The pipeline authenticates with OIDC, so there is no Azure secret stored in
GitHub. Run this once, substituting your repository:

```bash
SUBSCRIPTION=$(az account show --query id -o tsv)
TENANT=$(az account show --query tenantId -o tsv)
REPO="Hardikk1233/Tristone_Time_Tracking-tool"
RG="rg-timetrack-prod"

# An identity for the pipeline itself
APP_ID=$(az ad app create --display-name "TimeTrack Deploy" --query appId -o tsv)
az ad sp create --id "$APP_ID"

# Trust pushes to main from this repository - and nothing else
az ad app federated-credential create --id "$APP_ID" --parameters "{
  \"name\": \"github-main\",
  \"issuer\": \"https://token.actions.githubusercontent.com\",
  \"subject\": \"repo:${REPO}:ref:refs/heads/main\",
  \"audiences\": [\"api://AzureADTokenExchange\"]
}"

# Also allow the 'production' environment, used by manual runs
az ad app federated-credential create --id "$APP_ID" --parameters "{
  \"name\": \"github-production\",
  \"issuer\": \"https://token.actions.githubusercontent.com\",
  \"subject\": \"repo:${REPO}:environment:production\",
  \"audiences\": [\"api://AzureADTokenExchange\"]
}"

# Scoped to the one resource group, not the subscription
az role assignment create --assignee "$APP_ID" --role Contributor \
  --scope "/subscriptions/${SUBSCRIPTION}/resourceGroups/${RG}"

# Needed to push images
az role assignment create --assignee "$APP_ID" --role AcrPush \
  --scope "/subscriptions/${SUBSCRIPTION}/resourceGroups/${RG}"

echo "AZURE_CLIENT_ID       = $APP_ID"
echo "AZURE_TENANT_ID       = $TENANT"
echo "AZURE_SUBSCRIPTION_ID = $SUBSCRIPTION"
```

In the repository settings add:

**Secrets** - `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`

**Variables** - `AZURE_RESOURCE_GROUP`, `AZURE_CONTAINER_APP`,
`AZURE_MIGRATION_JOB`, `AZURE_REGISTRY_LOGIN_SERVER` (all four are printed by
`deploy.ps1`)

Create a **production** environment under Settings - Environments if you want
deploys to require approval.

## What a deploy does

Merging to `main` runs, in order:

1. **Build** the image for linux/amd64 and push it, tagged with the commit.
2. **Migrate** - the same image runs `dist/migrate.mjs` as a one-shot job. If
   it fails, the deploy stops here and the running revision is untouched.
3. **Release** a new revision. Container Apps starts it, waits for its health
   probe, then drains the old one - so the swap is invisible even on a single
   replica.
4. **Verify** the new revision answers `/api/healthz`, failing the run if not.

Migrations run before the release rather than at application startup so that a
bad migration produces one failed job instead of every replica crash-looping.

## Rolling back

Revisions are kept, so a rollback is a traffic switch rather than a rebuild:

```bash
az containerapp revision list -n <app> -g <rg> -o table

az containerapp ingress traffic set -n <app> -g <rg> \
  --revision-weight <previous-revision>=100
```

This does **not** roll back a migration. Migrations are written to be additive
so an older revision keeps working against a newer schema; anything genuinely
destructive should be split across two releases.

## Restoring the database

Point-in-time restore covers the retention window (35 days by default) and
creates a *new* server rather than overwriting the existing one:

```bash
az postgres flexible-server restore \
  --resource-group <rg> \
  --name <new-server-name> \
  --source-server <existing-server-name> \
  --restore-time "2026-08-20T09:30:00Z"
```

Then repoint `database-url` in Key Vault at the restored server and restart the
container app.

## Cost control

- The budget alerts at 80% forecast and 100% actual of the monthly figure.
- Log Analytics is capped at 0.2 GB/day, which is the line most likely to drift
  upward unnoticed.
- The largest single saving available is dropping the Container Registry (about
  $5/month) in favour of GitHub Container Registry.
- Adding a second always-on replica costs roughly $7/month and removes the
  brief gap if a container crashes. Change `minReplicas` in the template.
