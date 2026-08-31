// TimeTrack infrastructure.
//
// One Container App serving both the API and the built frontend, a small
// PostgreSQL Flexible Server reachable only from inside the virtual network,
// and the supporting pieces. Sized deliberately for an internal tool used by
// roughly 150 people: about USD 37/month at list prices.
//
// Deploy with infra/deploy.ps1, which creates the resource group first.

targetScope = 'resourceGroup'

// ─── Parameters ──────────────────────────────────────────────────────────────

@description('Azure region. Defaults to the resource group\'s own location.')
param location string = resourceGroup().location

@description('Short name used as a prefix for every resource.')
@minLength(3)
@maxLength(12)
param namePrefix string = 'timetrack'

@description('Environment discriminator, e.g. prod or staging.')
@allowed(['prod', 'staging'])
param environmentName string = 'prod'

@description('PostgreSQL administrator login.')
param databaseAdminUser string = 'ttadmin'

@description('PostgreSQL administrator password. Supply at deploy time; never commit it.')
@secure()
@minLength(16)
param databaseAdminPassword string

@description('Signing secret for express-session. Obsolete once ENTRA_ONLY is enabled, but required until then.')
@secure()
@minLength(32)
param sessionSecret string

@description('Entra directory (tenant) ID.')
param entraTenantId string

@description('Application ID URI of the TimeTrack API registration.')
param entraAudience string

@description('Client ID of the TimeTrack Web (SPA) registration.')
param entraSpaClientId string

@description('Scope the SPA requests, e.g. api://<id>/access_as_user.')
param entraApiScope string

@description('Refuse password sign-in, leaving Entra as the only way in. Flipped at cutover on 2026-08-24.')
param entraOnly bool = true

@description('''
Custom hostname for the app, e.g. timetrack.tristone-partners.com. Empty leaves
the app on its generated azurecontainerapps.io address.

Set this only once DNS resolves, because certificate issuance validates against
it and the deployment fails if it cannot:

  CNAME  timetrack        -> <the app FQDN>
  TXT    asuid.timetrack  -> the environment customDomainVerificationId

The certificate is a free managed one, renewed by Azure. Declaring the binding
here rather than adding it by hand keeps a later deploy from dropping it.
''')
param customDomain string = ''

@description('Container image to run. Left as the placeholder on first deploy; the pipeline sets the real one.')
param containerImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Monthly spend threshold in USD that triggers an alert.')
param monthlyBudgetUsd int = 40

@description('Email addresses notified when spend approaches the budget.')
param budgetAlertEmails array = []

@description('Keep a copy of backups in a second region. CANNOT be changed after the server is created.')
param geoRedundantBackup bool = false

@description('Days of point-in-time restore. Free up to the provisioned storage size.')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 35

@description('Leave at the default. Only used to date the budget from the current month.')
param deploymentDate string = utcNow('yyyy-MM')

@description('''
Prevents anyone permanently destroying Key Vault secrets, including an
administrator. Correct for production - but it also means a deleted vault name
stays reserved for 90 days and cannot be reclaimed, so a trial environment that
gets torn down cannot be recreated under the same name. Set false for a
throwaway deployment.
''')
param enablePurgeProtection bool = true

// ─── Naming ──────────────────────────────────────────────────────────────────

var suffix = uniqueString(resourceGroup().id)
var baseName = '${namePrefix}-${environmentName}'
// Registry and Key Vault names have tighter rules than everything else.
var registryName = toLower(replace('${namePrefix}${environmentName}${suffix}', '-', ''))
var keyVaultName = take(toLower('kv-${namePrefix}-${environmentName}-${suffix}'), 24)
var databaseName = 'timetracker'

var tags = {
  application: 'TimeTrack'
  environment: environmentName
  managedBy: 'bicep'
}

// ─── Observability ───────────────────────────────────────────────────────────

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${baseName}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    // The one line that keeps observability from quietly becoming the largest
    // bill item. An internal tool of this size produces well under this.
    workspaceCapping: {
      dailyQuotaGb: json('0.2')
    }
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

// ─── Network ─────────────────────────────────────────────────────────────────
// The database is never exposed to the internet. Both the app and the database
// live in this network, and the database has no public endpoint at all.

resource virtualNetwork 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-${baseName}'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: ['10.20.0.0/16']
    }
    subnets: [
      {
        // Container Apps requires at least a /23 for a consumption environment.
        name: 'snet-apps'
        properties: {
          addressPrefix: '10.20.0.0/23'
          delegations: [
            {
              name: 'containerapps'
              properties: { serviceName: 'Microsoft.App/environments' }
            }
          ]
        }
      }
      {
        name: 'snet-postgres'
        properties: {
          addressPrefix: '10.20.2.0/24'
          delegations: [
            {
              name: 'postgres'
              properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' }
            }
          ]
        }
      }
    ]
  }
}

resource appsSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: virtualNetwork
  name: 'snet-apps'
}

resource postgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: virtualNetwork
  name: 'snet-postgres'
}

// Resolves the database's private address from inside the network.
resource privateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: '${baseName}.private.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource privateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: privateDnsZone
  name: 'link-${baseName}'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: virtualNetwork.id }
  }
}

// ─── Database ────────────────────────────────────────────────────────────────

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'psql-${baseName}-${suffix}'
  location: location
  tags: tags
  sku: {
    // Burstable suits this workload precisely: short bursts around timesheet
    // deadlines, idle the rest of the month. Can be scaled in place later.
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: databaseAdminUser
    administratorLoginPassword: databaseAdminPassword
    storage: {
      // 32 GB is the tier minimum, and backups are free up to this size.
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup ? 'Enabled' : 'Disabled'
    }
    network: {
      delegatedSubnetResourceId: postgresSubnet.id
      privateDnsZoneArmResourceId: privateDnsZone.id
      publicNetworkAccess: 'Disabled'
    }
    highAvailability: {
      // Deliberately off. Recovery is by point-in-time restore rather than
      // automatic failover; enabling this roughly doubles the compute cost.
      mode: 'Disabled'
    }
  }
  dependsOn: [privateDnsLink]
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// ─── Container registry ──────────────────────────────────────────────────────

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    // The app pulls with a managed identity, so no registry password exists.
    adminUserEnabled: false
  }
}

// ─── Identity ────────────────────────────────────────────────────────────────
// One identity the app runs as: it pulls its own image and reads its own
// secrets. No credential is stored anywhere in the pipeline or the image.

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${baseName}'
  location: location
  tags: tags
}

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, identity.id, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource keyVaultAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, identity.id, keyVaultSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ─── Secrets ─────────────────────────────────────────────────────────────────

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    // Role assignments rather than access policies, so permissions are visible
    // alongside every other permission in the subscription.
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    // Null rather than false: the property cannot be set back to false once
    // enabled, so it is omitted entirely when not wanted.
    enablePurgeProtection: enablePurgeProtection ? true : null
    publicNetworkAccess: 'Enabled'
  }
}

var databaseUrl = 'postgresql://${databaseAdminUser}:${uriComponent(databaseAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=require'

resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'database-url'
  properties: {
    value: databaseUrl
    contentType: 'text/plain'
  }
}

resource sessionSecretSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'session-secret'
  properties: {
    value: sessionSecret
    contentType: 'text/plain'
  }
}

// ─── Container Apps environment ──────────────────────────────────────────────

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${baseName}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: appsSubnet.id
      // Ingress stays public; the app is reached over the internet while the
      // database is not.
      internal: false
    }
    zoneRedundant: false
  }
}

// A free managed certificate for the custom hostname, renewed by Azure. Azure
// validates ownership through the CNAME while issuing, so this resource is the
// one that fails if DNS is not in place yet.
resource domainCertificate 'Microsoft.App/managedEnvironments/managedCertificates@2024-03-01' = if (!empty(customDomain)) {
  parent: containerEnv
  name: 'cert-${replace(customDomain, '.', '-')}'
  location: location
  tags: tags
  properties: {
    subjectName: customDomain
    domainControlValidation: 'CNAME'
  }
}

// ─── The application ─────────────────────────────────────────────────────────

var appEnvironmentVariables = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'PORT', value: '8080' }
  { name: 'LOG_LEVEL', value: 'info' }
  { name: 'STATIC_DIR', value: '/app/public' }
  { name: 'TRUST_PROXY', value: 'true' }
  { name: 'DATABASE_SSL', value: 'true' }
  { name: 'DATABASE_POOL_MAX', value: '8' }
  { name: 'DATABASE_URL', secretRef: 'database-url' }
  { name: 'SESSION_SECRET', secretRef: 'session-secret' }
  { name: 'ENTRA_TENANT_ID', value: entraTenantId }
  { name: 'ENTRA_AUDIENCE', value: entraAudience }
  { name: 'ENTRA_SPA_CLIENT_ID', value: entraSpaClientId }
  { name: 'ENTRA_API_SCOPE', value: entraApiScope }
  { name: 'ENTRA_ONLY', value: string(entraOnly) }
]

var appSecrets = [
  {
    name: 'database-url'
    keyVaultUrl: '${keyVault.properties.vaultUri}secrets/database-url'
    identity: identity.id
  }
  {
    name: 'session-secret'
    keyVaultUrl: '${keyVault.properties.vaultUri}secrets/session-secret'
    identity: identity.id
  }
]

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-${baseName}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        // The generated azurecontainerapps.io hostname keeps working alongside
        // this, so adding a domain does not invalidate links already shared.
        customDomains: empty(customDomain) ? null : [
          {
            name: customDomain
            certificateId: domainCertificate.id
            bindingType: 'SniEnabled'
          }
        ]
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: appSecrets
    }
    template: {
      containers: [
        {
          name: 'timetrack'
          image: containerImage
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: appEnvironmentVariables
          probes: [
            {
              // Liveness deliberately ignores the database: restarting the
              // container cannot fix an unreachable database, and a failing
              // probe would turn an outage into a restart loop.
              type: 'Liveness'
              httpGet: { path: '/api/healthz', port: 8080 }
              initialDelaySeconds: 10
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              // Readiness does check it, so a replica with a dead pool is
              // taken out of rotation rather than serving errors.
              type: 'Readiness'
              httpGet: { path: '/api/readyz', port: 8080 }
              initialDelaySeconds: 5
              periodSeconds: 15
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        // One always-warm replica avoids cold starts; bursts scale out and are
        // billed only while they run. Raise minReplicas to 2 to remove the
        // brief gap if a container crashes - about USD 7/month.
        minReplicas: 1
        maxReplicas: 3
        rules: [
          {
            name: 'http-concurrency'
            http: { metadata: { concurrentRequests: '40' } }
          }
        ]
      }
    }
  }
  dependsOn: [acrPull, keyVaultAccess, databaseUrlSecret, sessionSecretSecret]
}

// ─── Migration job ───────────────────────────────────────────────────────────
// Runs the same image with a different command, before a new revision goes
// live. Kept out of application startup so a failed migration surfaces as one
// failed job rather than every replica crash-looping.

resource migrationJob 'Microsoft.App/jobs@2024-03-01' = {
  name: 'job-${baseName}-migrate'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    environmentId: containerEnv.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 1
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: appSecrets
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: containerImage
          command: ['node']
          args: ['dist/migrate.mjs']
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'LOG_LEVEL', value: 'info' }
            { name: 'DATABASE_SSL', value: 'true' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
          ]
        }
      ]
    }
  }
  dependsOn: [acrPull, keyVaultAccess, databaseUrlSecret, sessionSecretSecret]
}

// ─── Cost guard ──────────────────────────────────────────────────────────────

resource budget 'Microsoft.Consumption/budgets@2023-05-01' = if (!empty(budgetAlertEmails)) {
  name: 'budget-${baseName}'
  properties: {
    category: 'Cost'
    amount: monthlyBudgetUsd
    timeGrain: 'Monthly'
    timePeriod: {
      // Budgets need a start date on the first of a month.
      startDate: '${deploymentDate}-01'
    }
    notifications: {
      // Warns while there is still time to react, then again at the line.
      Forecasted80: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 80
        thresholdType: 'Forecasted'
        contactEmails: budgetAlertEmails
      }
      Actual100: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: budgetAlertEmails
      }
    }
  }
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

output applicationUrl string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output containerAppName string = containerApp.name
output migrationJobName string = migrationJob.name
output registryLoginServer string = registry.properties.loginServer
output registryName string = registry.name
output keyVaultName string = keyVault.name
output identityClientId string = identity.properties.clientId
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output resourceGroupName string = resourceGroup().name
