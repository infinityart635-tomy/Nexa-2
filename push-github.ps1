param(
    [string]$CommitMessage,
    [string]$RemoteUrl = 'https://github.com/infinityart635-tomy/Nexa-2.git',
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'

$script:Branch = 'main'
$script:RemoteName = 'origin'
$script:GitHubOwner = $null
$script:DefaultRemoteUrl = 'https://github.com/infinityart635-tomy/Nexa-2.git'

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [switch]$IgnoreExitCode
    )

    & git @Arguments
    $exitCode = $LASTEXITCODE
    if (-not $IgnoreExitCode -and $exitCode -ne 0) {
        throw "Git fallo: git $($Arguments -join ' ')"
    }
}

function Get-GitOutput {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = & git @Arguments 2>$null
    $exitCode = $LASTEXITCODE
    return [pscustomobject]@{
        Output = ($output | Where-Object { $_ -ne $null })
        ExitCode = $exitCode
    }
}

function Detect-GitHubOwner {
    param(
        [string]$Url
    )

    $script:GitHubOwner = $null
    if ([string]::IsNullOrWhiteSpace($Url)) {
        return
    }

    if ($Url -match '^https://github\.com/([^/]+)/') {
        $script:GitHubOwner = $Matches[1]
        return
    }

    if ($Url -match '^git@github\.com:([^/]+)/') {
        $script:GitHubOwner = $Matches[1]
    }
}

function Set-Remote {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url
    )

    $existing = Get-GitOutput -Arguments @('remote', 'get-url', $script:RemoteName)
    if ($existing.ExitCode -ne 0) {
        Invoke-Git -Arguments @('remote', 'add', $script:RemoteName, $Url)
    }
    else {
        Invoke-Git -Arguments @('remote', 'set-url', $script:RemoteName, $Url)
    }
}

function Show-GitHubAccounts {
    Write-Host ''
    Write-Host 'Cuentas guardadas en Git Credential Manager:'
    & git credential-manager github list 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host '  No se pudieron listar las cuentas guardadas.'
    }
    Write-Host ''
}

function Invoke-GitHubLogin {
    $loginChoice = Read-Host 'Queres iniciar sesion otra vez en GitHub ahora? [s/N]'
    if ($loginChoice -notmatch '^[sS]$') {
        return $false
    }

    $loginUser = Read-Host 'Usuario de GitHub para entrar (opcional)'

    if ([string]::IsNullOrWhiteSpace($loginUser)) {
        & git credential-manager github login --device --force
    }
    else {
        & git credential-manager github login --device --username $loginUser --force
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Fallo el login de GitHub.'
        return $false
    }

    Write-Host 'Login completado. Reintentando acceso...'
    return $true
}

function Test-RemoteAccess {
    if ($script:GitHubOwner) {
        & git '-c' "credential.username=$script:GitHubOwner" 'ls-remote' $script:RemoteName > $null 2>&1
    }
    else {
        & git 'ls-remote' $script:RemoteName > $null 2>&1
    }
    return ($LASTEXITCODE -eq 0)
}

function Ensure-Remote {
    param(
        [string]$RequestedRemoteUrl
    )

    if ([string]::IsNullOrWhiteSpace($RequestedRemoteUrl)) {
        $RequestedRemoteUrl = $script:DefaultRemoteUrl
    }

    if (-not [string]::IsNullOrWhiteSpace($RequestedRemoteUrl)) {
        Set-Remote -Url $RequestedRemoteUrl
    }

    while ($true) {
        $currentRemote = (Get-GitOutput -Arguments @('remote', 'get-url', $script:RemoteName)).Output | Select-Object -First 1
        if ([string]::IsNullOrWhiteSpace($currentRemote)) {
            Write-Host "No hay un remote $($script:RemoteName) configurado."
        }
        else {
            Detect-GitHubOwner -Url $currentRemote
            Write-Host "Remote actual: $currentRemote"
            if (Test-RemoteAccess) {
                return
            }

            Write-Host 'Git no pudo acceder al remote:'
            Write-Host "  $currentRemote"
            if ($script:GitHubOwner) {
                Write-Host "Usuario sugerido para GitHub: $($script:GitHubOwner)"
            }
            Write-Host ''
            Write-Host 'Si el repo es privado, GitHub tambien responde asi cuando estas logueado con otra cuenta o sin permisos.'
            Show-GitHubAccounts
            if (Invoke-GitHubLogin -and (Test-RemoteAccess)) {
                return
            }
        }

        Write-Host ''
        Write-Host 'Pega la URL correcta del repo para probar otra vez.'
        Write-Host "Enter para usar la URL por defecto: $($script:DefaultRemoteUrl)"
        $RequestedRemoteUrl = Read-Host 'URL del repo'
        if ([string]::IsNullOrWhiteSpace($RequestedRemoteUrl)) {
            $RequestedRemoteUrl = $script:DefaultRemoteUrl
        }
        Set-Remote -Url $RequestedRemoteUrl
    }
}

function Invoke-Push {
    if ($script:GitHubOwner) {
        Invoke-Git -Arguments @('-c', "credential.username=$script:GitHubOwner", 'push', '-u', $script:RemoteName, $script:Branch)
    }
    else {
        Invoke-Git -Arguments @('push', '-u', $script:RemoteName, $script:Branch)
    }
}

function Invoke-PushDryRun {
    if ($script:GitHubOwner) {
        Invoke-Git -Arguments @('-c', "credential.username=$script:GitHubOwner", 'push', '-u', $script:RemoteName, $script:Branch, '--dry-run')
    }
    else {
        Invoke-Git -Arguments @('push', '-u', $script:RemoteName, $script:Branch, '--dry-run')
    }
}

try {
    Set-Location -LiteralPath $PSScriptRoot

    $insideRepo = Get-GitOutput -Arguments @('rev-parse', '--is-inside-work-tree')
    if ($insideRepo.ExitCode -ne 0) {
        Write-Host 'No habia un repositorio Git. Inicializando...'
        Invoke-Git -Arguments @('init', '-b', $script:Branch)
    }

    $branchExists = Get-GitOutput -Arguments @('show-ref', '--verify', '--quiet', "refs/heads/$($script:Branch)")
    if ($branchExists.ExitCode -ne 0) {
        Invoke-Git -Arguments @('checkout', '-b', $script:Branch)
    }
    else {
        Invoke-Git -Arguments @('checkout', $script:Branch)
    }

    Ensure-Remote -RequestedRemoteUrl $RemoteUrl
    Invoke-Git -Arguments @('status', '-sb')

    if ($DryRun) {
        Write-Host 'Modo prueba: no se hace commit ni push real.'
        Invoke-PushDryRun
        Write-Host 'Prueba completada.'
        exit 0
    }

    Invoke-Git -Arguments @('add', '-A')
    Invoke-Git -Arguments @('status', '-sb')

    if ([string]::IsNullOrWhiteSpace($CommitMessage)) {
        $CommitMessage = 'Actualizacion automatica ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    }

    & git diff --cached --quiet
    $hasStagedChanges = $LASTEXITCODE
    if ($hasStagedChanges -ne 0) {
        Invoke-Git -Arguments @('commit', '-m', $CommitMessage)
    }
    else {
        Write-Host 'No hay cambios para commit.'
    }

    Invoke-Push
    Write-Host 'Push completado.'
    exit 0
}
catch {
    Write-Host $_.Exception.Message
    exit 1
}
