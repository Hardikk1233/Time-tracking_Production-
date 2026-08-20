<#
.SYNOPSIS
    Creates the Microsoft Entra ID objects TimeTrack needs for Microsoft sign-in.

.DESCRIPTION
    Does everything the manual portal runbook describes, in one reviewable pass:

      * "TimeTrack API" - app registration, Application ID URI, access_as_user
                           scope, and the four TimeTrack app roles
      * "TimeTrack Web" - SPA registration with redirect URIs, permission to
                           call the API, and admin consent
      * Four security groups, each assigned to its matching app role
      * "Assignment required" turned on, so only group members can get a token

    Safe to re-run: existing objects are reused rather than duplicated, and
    nothing is deleted. Creating these objects does not change the behaviour of
    the running application - TimeTrack only begins accepting Microsoft sign-in
    once the values printed at the end are configured on it.

.PARAMETER RedirectUri
    Where staff will use the app, e.g. https://timetrack.tristone-partners.com

.PARAMETER IdentifierUri
    Application ID URI for the API. Some tenants refuse a custom value unless
    the domain is verified; pass api://<something> or let it fall back.

.PARAMETER WhatIf
    Report what would be created without changing anything.

.EXAMPLE
    ./setup-entra.ps1 -RedirectUri "https://timetrack.tristone-partners.com" -WhatIf
    ./setup-entra.ps1 -RedirectUri "https://timetrack.tristone-partners.com"

.NOTES
    Requires: Azure CLI, and sign-in as a Global Administrator (or the trio of
    Application Administrator, Cloud Application Administrator and Groups
    Administrator).

    Group-to-role assignment needs Microsoft Entra ID P1 or P2. On the free
    tier the script still creates everything and tells you which people to
    assign by hand.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string] $RedirectUri,

    [string] $IdentifierUri = "api://timetrack-api",

    [string] $ApiAppName = "TimeTrack API",
    [string] $SpaAppName = "TimeTrack Web",

    [string[]] $ExtraRedirectUris = @("http://localhost:5173"),

    [switch] $SkipGroups,

    # Skip the confirmation prompt, for unattended runs.
    [switch] $Force
)

$ErrorActionPreference = "Stop"
$GRAPH = "https://graph.microsoft.com/v1.0"

# Fixed ids so re-running does not churn the role definitions.
$ROLE_SCOPE_ID = "0f7bd7c9-1d3a-4c3e-9c2a-5c9f2b8a4e11"
$ROLES = @(
    @{ Value = "TimeTrack.MD";        Display = "MD";        Description = "Managing Director";           Id = "b1f3a6c2-7d64-4a1e-9b52-2c8d5f0a7e31"; Group = "TimeTrack-MDs" }
    @{ Value = "TimeTrack.AVP";       Display = "AVP";       Description = "Associate Vice President";    Id = "c2a4b7d3-8e75-4b2f-8c63-3d9e6a1b8f42"; Group = "TimeTrack-AVPs" }
    @{ Value = "TimeTrack.Associate"; Display = "Associate"; Description = "Associate";                   Id = "d3b5c8e4-9f86-4c30-9d74-4e0f7b2c9a53"; Group = "TimeTrack-Associates" }
    @{ Value = "TimeTrack.Analyst";   Display = "Analyst";   Description = "Analyst";                     Id = "e4c6d9f5-0a97-4d41-8e85-5f1a8c3d0b64"; Group = "TimeTrack-Analysts" }
)

# --- Helpers -----------------------------------------------------------------

<#
  Works out how to actually invoke the Azure CLI on this machine.

  What is on PATH as 'az' is often the extension-less *bash* wrapper that ships
  beside the Windows shim. PowerShell cannot run it - it prints the file's
  contents and does nothing - which looks exactly like a command that silently
  succeeded. Some installs ship no az.cmd at all, only that wrapper and a
  signed azps.ps1, and the latter is itself blocked by execution policy.

  So: prefer a real .cmd/.bat shim, and otherwise drive the bundled Python
  directly, which is precisely what both wrappers do internally.

  Returns @{ Exe = <path>; Prefix = @(...); Describe = <text> }
#>
function Resolve-AzInvoker {
    foreach ($name in @("az.cmd", "az.bat")) {
        $found = Get-Command $name -ErrorAction SilentlyContinue
        if ($found) {
            return @{ Exe = $found.Source; Prefix = @(); Describe = $found.Source }
        }
    }

    $roots = @(
        "$env:ProgramFiles\Microsoft SDKs\Azure\CLI2",
        "${env:ProgramFiles(x86)}\Microsoft SDKs\Azure\CLI2",
        "$env:LOCALAPPDATA\Programs\Microsoft SDKs\Azure\CLI2"
    )

    foreach ($root in $roots) {
        $shim = Join-Path $root "wbin\az.cmd"
        if (Test-Path $shim) {
            return @{ Exe = $shim; Prefix = @(); Describe = $shim }
        }
    }

    foreach ($root in $roots) {
        $python = Join-Path $root "python.exe"
        if (Test-Path $python) {
            return @{
                Exe      = $python
                Prefix   = @("-IBm", "azure.cli")
                Describe = "$python -IBm azure.cli  (no az.cmd shim on this machine)"
            }
        }
    }

    throw "Azure CLI not found. Install it from https://aka.ms/installazurecli"
}

$script:AZ = Resolve-AzInvoker
# Matches what the shipped wrappers set; some commands read it for telemetry.
if (-not $env:AZ_INSTALLER) { $env:AZ_INSTALLER = "MSI" }

function Invoke-Az {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Arguments)
    $full = @($script:AZ.Prefix) + $Arguments
    $output = & $script:AZ.Exe @full 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "az $($Arguments -join ' ') failed:`n$($output -join "`n")"
    }
    return ($output -join "`n")
}

function Invoke-AzJson {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Arguments)
    $text = Invoke-Az @Arguments
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return $text | ConvertFrom-Json
}

<# Graph calls that az's `ad` commands do not cover (app role assignment,
   assignmentRequired). Bodies are written to a temp file because quoting JSON
   through the CLI is unreliable on Windows. #>
function Invoke-Graph {
    param(
        [Parameter(Mandatory = $true)][ValidateSet("get", "post", "patch")] [string] $Method,
        [Parameter(Mandatory = $true)] [string] $Url,
        [object] $Body
    )
    # Not $args: that is an automatic variable and assigning to it is unsafe.
    $azArgs = @("rest", "--method", $Method, "--url", $Url, "--headers", "Content-Type=application/json")
    $tmp = $null
    if ($Body) {
        $tmp = [System.IO.Path]::GetTempFileName()
        ($Body | ConvertTo-Json -Depth 12 -Compress) | Out-File -FilePath $tmp -Encoding utf8 -NoNewline
        $azArgs += @("--body", "@$tmp")
    }
    try { return Invoke-AzJson @azArgs }
    finally { if ($tmp -and (Test-Path $tmp)) { Remove-Item $tmp -Force } }
}

function Write-Step { param([string] $Text) Write-Host "`n> $Text" -ForegroundColor Cyan }
function Write-Done { param([string] $Text) Write-Host "  [ok] $Text" -ForegroundColor Green }
function Write-Kept { param([string] $Text) Write-Host "  * $Text" -ForegroundColor DarkGray }
function Write-Warn { param([string] $Text) Write-Host "  ! $Text" -ForegroundColor Yellow }

# --- Preflight ---------------------------------------------------------------

Write-Step "Checking sign-in"
Write-Host "  Using   : $($script:AZ.Describe)" -ForegroundColor DarkGray
try { $account = Invoke-AzJson account show --output json }
catch {
    $loginCommand = if ($script:AZ.Prefix.Count -gt 0) {
        "& `"$($script:AZ.Exe)`" $($script:AZ.Prefix -join ' ') login --allow-no-subscriptions"
    }
    else {
        "& `"$($script:AZ.Exe)`" login --allow-no-subscriptions"
    }

    throw @"
Not signed in to Azure.

Run this exact command first - plain 'az' will not work in PowerShell on this
machine, because what is on PATH is a bash wrapper that silently does nothing:

    $loginCommand

A browser window opens; sign in with an account that can administer the
directory. Then run this script again.
"@
}

$tenantId = $account.tenantId
Write-Host "  Tenant  : $tenantId"
Write-Host "  Account : $($account.user.name)"

if ($WhatIfPreference) {
    Write-Warn "WhatIf mode - nothing will be created."
}
elseif (-not $Force) {
    Write-Host ""
    Write-Host "  This creates app registrations and groups in the tenant above." -ForegroundColor Yellow
    $reply = Read-Host "  Continue? (yes/no)"
    if ($reply -ne "yes") { Write-Host "Aborted."; exit 1 }
}

# --- 1. The API registration -------------------------------------------------

Write-Step "App registration: $ApiAppName"

$apiApp = Invoke-AzJson ad app list --display-name $ApiAppName --output json | Select-Object -First 1
if (-not $apiApp) {
    if ($PSCmdlet.ShouldProcess($ApiAppName, "Create app registration")) {
        $apiApp = Invoke-AzJson ad app create --display-name $ApiAppName --sign-in-audience AzureADMyOrg --output json
        Write-Done "created"
    }
}
else { Write-Kept "already exists - reusing" }

if (-not $apiApp) { Write-Warn "WhatIf: remaining steps need a real app; stopping."; exit 0 }

$apiAppId    = $apiApp.appId
$apiObjectId = $apiApp.id

# Application ID URI. A custom value can be refused when the domain is not
# verified, in which case api://<client-id> is always accepted.
$effectiveIdentifierUri = $IdentifierUri
if ($PSCmdlet.ShouldProcess($effectiveIdentifierUri, "Set Application ID URI")) {
    try {
        Invoke-Graph -Method patch -Url "$GRAPH/applications/$apiObjectId" -Body @{ identifierUris = @($IdentifierUri) } | Out-Null
        Write-Done "identifier URI: $IdentifierUri"
    }
    catch {
        $effectiveIdentifierUri = "api://$apiAppId"
        Write-Warn "'$IdentifierUri' was refused; falling back to $effectiveIdentifierUri"
        Invoke-Graph -Method patch -Url "$GRAPH/applications/$apiObjectId" -Body @{ identifierUris = @($effectiveIdentifierUri) } | Out-Null
        Write-Done "identifier URI: $effectiveIdentifierUri"
    }
}

# Scope + roles in one patch, so a partial failure cannot leave half a manifest.
if ($PSCmdlet.ShouldProcess($ApiAppName, "Define access_as_user scope and four app roles")) {
    $appRoles = $ROLES | ForEach-Object {
        @{
            allowedMemberTypes = @("User")   # "User" covers users *and* groups
            description        = $_.Description
            displayName        = $_.Display
            id                 = $_.Id
            isEnabled          = $true
            value              = $_.Value
        }
    }

    Invoke-Graph -Method patch -Url "$GRAPH/applications/$apiObjectId" -Body @{
        appRoles = @($appRoles)
        api      = @{
            oauth2PermissionScopes = @(
                @{
                    id                      = $ROLE_SCOPE_ID
                    adminConsentDisplayName = "Access TimeTrack"
                    adminConsentDescription = "Allows the signed-in user to use TimeTrack"
                    userConsentDisplayName  = "Access TimeTrack"
                    userConsentDescription  = "Allows you to use TimeTrack"
                    value                   = "access_as_user"
                    type                    = "Admin"
                    isEnabled               = $true
                }
            )
        }
    } | Out-Null
    Write-Done "scope access_as_user and 4 app roles defined"
}

# The enterprise application - where role assignment and assignmentRequired live.
$apiSp = Invoke-AzJson ad sp list --filter "appId eq '$apiAppId'" --output json | Select-Object -First 1
if (-not $apiSp) {
    if ($PSCmdlet.ShouldProcess($ApiAppName, "Create service principal")) {
        $apiSp = Invoke-AzJson ad sp create --id $apiAppId --output json
        Write-Done "enterprise application created"
    }
}
else { Write-Kept "enterprise application already exists" }

# --- 2. The SPA registration -------------------------------------------------

Write-Step "App registration: $SpaAppName"

$allRedirects = @($RedirectUri) + $ExtraRedirectUris | Select-Object -Unique

$spaApp = Invoke-AzJson ad app list --display-name $SpaAppName --output json | Select-Object -First 1
if (-not $spaApp) {
    if ($PSCmdlet.ShouldProcess($SpaAppName, "Create SPA registration")) {
        $spaApp = Invoke-AzJson ad app create --display-name $SpaAppName --sign-in-audience AzureADMyOrg --output json
        Write-Done "created"
    }
}
else { Write-Kept "already exists - reusing" }

if ($spaApp) {
    $spaAppId    = $spaApp.appId
    $spaObjectId = $spaApp.id

    if ($PSCmdlet.ShouldProcess($SpaAppName, "Set SPA redirect URIs and API permission")) {
        # spa.redirectUris (not web.redirectUris) is what makes this a public
        # client using auth-code with PKCE - no client secret anywhere.
        Invoke-Graph -Method patch -Url "$GRAPH/applications/$spaObjectId" -Body @{
            spa                   = @{ redirectUris = @($allRedirects) }
            requiredResourceAccess = @(
                @{
                    resourceAppId  = $apiAppId
                    resourceAccess = @(@{ id = $ROLE_SCOPE_ID; type = "Scope" })
                }
            )
        } | Out-Null
        Write-Done "redirect URIs: $($allRedirects -join ', ')"
        Write-Done "permission to call $ApiAppName requested"
    }

    $spaSp = Invoke-AzJson ad sp list --filter "appId eq '$spaAppId'" --output json | Select-Object -First 1
    if (-not $spaSp -and $PSCmdlet.ShouldProcess($SpaAppName, "Create service principal")) {
        Invoke-AzJson ad sp create --id $spaAppId --output json | Out-Null
        Write-Done "enterprise application created"
    }

    if ($PSCmdlet.ShouldProcess($SpaAppName, "Grant admin consent")) {
        # Consent occasionally races the freshly-created service principal.
        $granted = $false
        foreach ($attempt in 1..3) {
            try {
                Invoke-Az ad app permission admin-consent --id $spaAppId | Out-Null
                $granted = $true; break
            }
            catch { Start-Sleep -Seconds 5 }
        }
        if ($granted) { Write-Done "admin consent granted" }
        else { Write-Warn "admin consent failed - grant it in the portal: $SpaAppName > API permissions > Grant admin consent" }
    }
}

# --- 3. Groups and role assignment -------------------------------------------

if (-not $SkipGroups) {
    Write-Step "Security groups and role assignment"

    $apiSpObjectId = $apiSp.id
    $existing = @()
    if ($apiSpObjectId) {
        try {
            $existing = (Invoke-Graph -Method get -Url "$GRAPH/servicePrincipals/$apiSpObjectId/appRoleAssignedTo").value
        }
        catch { $existing = @() }
    }

    foreach ($role in $ROLES) {
        $groupName = $role.Group

        $group = Invoke-AzJson ad group list --display-name $groupName --output json | Select-Object -First 1
        if (-not $group) {
            if ($PSCmdlet.ShouldProcess($groupName, "Create security group")) {
                $group = Invoke-AzJson ad group create --display-name $groupName --mail-nickname $groupName --output json
                Write-Done "group $groupName created"
            }
        }
        else { Write-Kept "group $groupName already exists" }

        if (-not $group -or -not $apiSpObjectId) { continue }

        $alreadyAssigned = $existing | Where-Object {
            $_.principalId -eq $group.id -and $_.appRoleId -eq $role.Id
        }
        if ($alreadyAssigned) { Write-Kept "$groupName already holds $($role.Display)"; continue }

        if ($PSCmdlet.ShouldProcess("$groupName -> $($role.Display)", "Assign app role")) {
            try {
                Invoke-Graph -Method post -Url "$GRAPH/groups/$($group.id)/appRoleAssignments" -Body @{
                    principalId = $group.id
                    resourceId  = $apiSpObjectId
                    appRoleId   = $role.Id
                } | Out-Null
                Write-Done "$groupName -> $($role.Display)"
            }
            catch {
                Write-Warn "could not assign $groupName -> $($role.Display)."
                Write-Warn "  Group-based assignment needs Entra ID P1/P2. On the free tier,"
                Write-Warn "  assign individual users to the $($role.Display) role in the portal instead."
            }
        }
    }
}

# --- 4. Require assignment ---------------------------------------------------

Write-Step "Restricting access to assigned members"
if ($apiSp -and $PSCmdlet.ShouldProcess($ApiAppName, "Set assignment required")) {
    Invoke-Graph -Method patch -Url "$GRAPH/servicePrincipals/$($apiSp.id)" -Body @{
        appRoleAssignmentRequired = $true
    } | Out-Null
    Write-Done "only members of the four groups can obtain a token"
}

# --- 5. What to configure TimeTrack with -------------------------------------

if (-not $WhatIfPreference) {
    $scope = "$effectiveIdentifierUri/access_as_user"

    Write-Host "`n----------------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host " Configure TimeTrack with these four values" -ForegroundColor White
    Write-Host " None are secret - this setup uses no client secret by design." -ForegroundColor DarkGray
    Write-Host "----------------------------------------------------------------`n" -ForegroundColor DarkGray

    Write-Host "ENTRA_TENANT_ID=$tenantId"
    Write-Host "ENTRA_AUDIENCE=$effectiveIdentifierUri"
    Write-Host "ENTRA_SPA_CLIENT_ID=$spaAppId"
    Write-Host "ENTRA_API_SCOPE=$scope"

    $envPath = Join-Path (Split-Path $PSScriptRoot -Parent) ".env.entra"
    @(
        "ENTRA_TENANT_ID=$tenantId",
        "ENTRA_AUDIENCE=$effectiveIdentifierUri",
        "ENTRA_SPA_CLIENT_ID=$spaAppId",
        "ENTRA_API_SCOPE=$scope"
    ) | Out-File -FilePath $envPath -Encoding utf8
    Write-Host "`nAlso written to: $envPath" -ForegroundColor DarkGray

    Write-Host "`nStill to do by hand:" -ForegroundColor Yellow
    Write-Host "  * Add people to the four TimeTrack-* groups."
    Write-Host "  * Optionally apply your Conditional Access policy to '$ApiAppName'."
    Write-Host "`nNothing changes for users until the values above are set on the app." -ForegroundColor DarkGray
}
