<#
.SYNOPSIS
    Creates or updates the TimeTrack Azure environment.

.DESCRIPTION
    Deploys infra/main.bicep into a resource group, creating the group first if
    it does not exist. Safe to re-run: Bicep deployments are declarative, so a
    second run reconciles rather than duplicates.

    On the first run the app starts on a placeholder image, because nothing has
    been published to the registry yet. The deploy pipeline replaces it with the
    real build. That is expected - the app will not work until then.

.PARAMETER ResourceGroup
    Resource group to deploy into. Created if missing.

.PARAMETER Location
    Azure region, e.g. centralindia.

.PARAMETER SubscriptionId
    Subscription to deploy into. Defaults to the current one.

.PARAMETER AlertEmail
    Address notified when spend approaches the monthly budget.

.PARAMETER WhatIf
    Show what would change without changing anything.

.EXAMPLE
    ./deploy.ps1 -ResourceGroup rg-timetrack-prod -Location centralindia -AlertEmail you@tristone-partners.com -WhatIf
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)] [string] $ResourceGroup,
    [Parameter(Mandatory = $true)] [string] $Location,

    [string] $SubscriptionId,
    [string] $EnvironmentName = "prod",
    [string] $AlertEmail,

    # Custom hostname, e.g. timetrack.tristone-partners.com. Only pass this once
    # the CNAME and asuid TXT records resolve: certificate issuance validates
    # against them and the deployment fails if it cannot.
    [string] $CustomDomain,
    [int]    $MonthlyBudgetUsd = 40,
    [switch] $GeoRedundantBackup,

    # For a trial run you intend to delete afterwards. Without this, the Key
    # Vault name stays reserved for 90 days and the environment cannot be
    # recreated under the same name.
    [switch] $Disposable,

    [switch] $Force
)

$ErrorActionPreference = "Stop"

# --- Azure CLI ---------------------------------------------------------------
# Some installs ship no az.cmd, only a bash wrapper PowerShell cannot execute,
# so fall back to driving the bundled Python exactly as the wrappers do.
function Resolve-AzInvoker {
    foreach ($name in @("az.cmd", "az.bat")) {
        $found = Get-Command $name -ErrorAction SilentlyContinue
        if ($found) { return @{ Exe = $found.Source; Prefix = @() } }
    }
    $roots = @(
        "$env:ProgramFiles\Microsoft SDKs\Azure\CLI2",
        "${env:ProgramFiles(x86)}\Microsoft SDKs\Azure\CLI2",
        "$env:LOCALAPPDATA\Programs\Microsoft SDKs\Azure\CLI2"
    )
    foreach ($root in $roots) {
        $shim = Join-Path $root "wbin\az.cmd"
        if (Test-Path $shim) { return @{ Exe = $shim; Prefix = @() } }
    }
    foreach ($root in $roots) {
        $python = Join-Path $root "python.exe"
        if (Test-Path $python) { return @{ Exe = $python; Prefix = @("-IBm", "azure.cli") } }
    }
    throw "Azure CLI not found. Install it from https://aka.ms/installazurecli"
}

$script:AZ = Resolve-AzInvoker
if (-not $env:AZ_INSTALLER) { $env:AZ_INSTALLER = "MSI" }

function Invoke-Az {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Arguments)
    $full = @($script:AZ.Prefix) + $Arguments
    $output = & $script:AZ.Exe @full 2>&1
    if ($LASTEXITCODE -ne 0) { throw "az $($Arguments -join ' ') failed:`n$($output -join "`n")" }
    return ($output -join "`n")
}
function Invoke-AzJson {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Arguments)
    $text = Invoke-Az @Arguments
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return $text | ConvertFrom-Json
}

function Write-Step { param([string] $T) Write-Host "`n> $T" -ForegroundColor Cyan }
function Write-Done { param([string] $T) Write-Host "  [ok] $T" -ForegroundColor Green }
function Write-Note { param([string] $T) Write-Host "  * $T" -ForegroundColor DarkGray }

# --- Preflight ---------------------------------------------------------------

Write-Step "Checking sign-in"
try { $account = Invoke-AzJson account show --output json }
catch { throw "Not signed in. Run:  az login" }

if ($SubscriptionId) {
    Invoke-Az account set --subscription $SubscriptionId | Out-Null
    $account = Invoke-AzJson account show --output json
}

Write-Host "  Subscription : $($account.name)  [$($account.id)]"
Write-Host "  Tenant       : $($account.tenantId)"
Write-Host "  Account      : $($account.user.name)"

# --- Secrets -----------------------------------------------------------------
# Generated here rather than prompted for, so nothing weak or reused is chosen
# by hand. Both are stored in Key Vault by the template and never printed.

function New-StrongSecret {
    param([int] $Bytes = 32)
    $buffer = New-Object byte[] $Bytes
    # Create()+GetBytes works on both .NET Framework (Windows PowerShell 5.1)
    # and .NET Core; the static Fill() overload exists only on the latter.
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    # Base64url: no characters that need escaping inside a connection string.
    return [Convert]::ToBase64String($buffer).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

Write-Step "Preparing configuration"

$entraFile = Join-Path (Split-Path $PSScriptRoot -Parent) ".env.entra"
if (-not (Test-Path $entraFile)) {
    throw @"
Cannot find $entraFile.

Run scripts/setup-entra.cmd first - it registers the applications and writes
the four values this deployment needs.
"@
}

$entra = @{}
Get-Content $entraFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') { $entra[$Matches[1]] = $Matches[2] }
}
foreach ($key in @("ENTRA_TENANT_ID", "ENTRA_AUDIENCE", "ENTRA_SPA_CLIENT_ID", "ENTRA_API_SCOPE")) {
    if (-not $entra.ContainsKey($key)) { throw "$entraFile is missing $key" }
}
Write-Done "Entra settings loaded from .env.entra"

$databasePassword = New-StrongSecret -Bytes 24
$sessionSecret = New-StrongSecret -Bytes 32
Write-Done "generated database password and session secret"
Write-Note "both go straight into Key Vault; neither is written to disk"

# --- Resource group ----------------------------------------------------------

Write-Step "Resource group: $ResourceGroup"
$exists = Invoke-AzJson group exists --name $ResourceGroup --output json
if ($exists -eq $true -or $exists -eq "true") {
    Write-Note "already exists"
}
elseif ($PSCmdlet.ShouldProcess($ResourceGroup, "Create resource group")) {
    Invoke-Az group create --name $ResourceGroup --location $Location --output none
    Write-Done "created in $Location"
}

# --- Deploy ------------------------------------------------------------------

$template = Join-Path $PSScriptRoot "main.bicep"
$alertEmails = if ($AlertEmail) { "[`"$AlertEmail`"]" } else { "[]" }

$parameters = @(
    "location=$Location",
    "environmentName=$EnvironmentName",
    "databaseAdminPassword=$databasePassword",
    "sessionSecret=$sessionSecret",
    "entraTenantId=$($entra['ENTRA_TENANT_ID'])",
    "entraAudience=$($entra['ENTRA_AUDIENCE'])",
    "entraSpaClientId=$($entra['ENTRA_SPA_CLIENT_ID'])",
    "entraApiScope=$($entra['ENTRA_API_SCOPE'])",
    "customDomain=$CustomDomain",
    "monthlyBudgetUsd=$MonthlyBudgetUsd",
    "geoRedundantBackup=$($GeoRedundantBackup.IsPresent.ToString().ToLower())",
    "enablePurgeProtection=$((-not $Disposable).ToString().ToLower())",
    "budgetAlertEmails=$alertEmails"
)

if ($WhatIfPreference) {
    Write-Step "Previewing changes (nothing will be created)"
    # Not $args: that is an automatic variable and assigning to it is unsafe.
    $whatIfArgs = @("deployment", "group", "what-if", "--resource-group", $ResourceGroup,
        "--template-file", $template, "--parameters") + $parameters
    & $script:AZ.Exe @($script:AZ.Prefix + $whatIfArgs)
    Write-Host "`nRe-run without -WhatIf to apply." -ForegroundColor Yellow
    exit 0
}

if (-not $Force) {
    Write-Host ""
    Write-Host "  About to create Azure resources costing roughly USD $MonthlyBudgetUsd/month." -ForegroundColor Yellow
    if ($GeoRedundantBackup) {
        Write-Host "  Geo-redundant backup is ON. This CANNOT be changed later." -ForegroundColor Yellow
    }
    else {
        Write-Host "  Geo-redundant backup is OFF. This CANNOT be enabled later." -ForegroundColor Yellow
    }
    $reply = Read-Host "  Continue? (yes/no)"
    if ($reply -ne "yes") { Write-Host "Aborted."; exit 1 }
}

Write-Step "Deploying (this takes 10-15 minutes; the database is the slow part)"
$deploymentName = "timetrack-$EnvironmentName-$(Get-Random -Maximum 99999)"

$deployArgs = @("deployment", "group", "create",
    "--name", $deploymentName,
    "--resource-group", $ResourceGroup,
    "--template-file", $template,
    "--parameters") + $parameters + @("--output", "json")

$result = & $script:AZ.Exe @($script:AZ.Prefix + $deployArgs) 2>&1
if ($LASTEXITCODE -ne 0) { throw "Deployment failed:`n$($result -join "`n")" }

$outputs = ($result -join "`n" | ConvertFrom-Json).properties.outputs
Write-Done "deployed"

# --- Report ------------------------------------------------------------------

Write-Host "`n----------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host " Environment ready" -ForegroundColor White
Write-Host "----------------------------------------------------------------`n" -ForegroundColor DarkGray

Write-Host "Application URL : $($outputs.applicationUrl.value)"
Write-Host "Container app   : $($outputs.containerAppName.value)"
Write-Host "Migration job   : $($outputs.migrationJobName.value)"
Write-Host "Registry        : $($outputs.registryLoginServer.value)"
Write-Host "Key Vault       : $($outputs.keyVaultName.value)"

Write-Host "`nNext:" -ForegroundColor Yellow
Write-Host "  1. Add the application URL as a redirect URI on the TimeTrack Web"
Write-Host "     registration, otherwise Microsoft sign-in will be refused:"
Write-Host "       $($outputs.applicationUrl.value)" -ForegroundColor Cyan
Write-Host "  2. Push a build. The app runs a placeholder image until then."
Write-Host "     Either merge to main, or run .github/workflows/deploy.yml manually."

Write-Host "`nThe app will not serve TimeTrack until step 2 completes." -ForegroundColor DarkGray
