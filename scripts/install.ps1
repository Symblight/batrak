# Installs the batrak CLI: irm https://github.com/Symblight/batrak/releases/latest/download/install.ps1 | iex
# BATRAK_RELEASE_URL replaces the download's base URL, for testing only.
#
# Runs inside the user's own shell through iex: everything stays in a function, a failure throws rather
# than exits, and preferences are set in the function's scope only.

function Install-Batrak {
    $ErrorActionPreference = 'Stop'
    # Windows PowerShell's progress bar slows a download by an order of magnitude.
    $ProgressPreference = 'SilentlyContinue'

    if ($env:OS -ne 'Windows_NT') {
        throw 'batrak install: install.ps1 is for Windows; on macOS and Linux use install.sh'
    }
    # A 32-bit PowerShell on 64-bit Windows reports x86 in PROCESSOR_ARCHITECTURE.
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    if ($arch -ne 'AMD64') {
        throw "batrak install: unsupported architecture: $arch (batrak has a Windows build for x86_64)"
    }
    if (-not $env:LOCALAPPDATA) {
        throw 'batrak install: LOCALAPPDATA is not set'
    }

    $base = $env:BATRAK_RELEASE_URL
    if (-not $base) { $base = 'https://github.com/Symblight/batrak/releases/latest/download' }
    $url = "$base/batrak-x86_64-pc-windows-msvc.exe"
    $dir = Join-Path $env:LOCALAPPDATA 'Programs\batrak'
    $exe = Join-Path $dir 'batrak.exe'

    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    # In the install folder, so the final move is a rename on one filesystem.
    $tmp = Join-Path $dir ".batrak-install-$([guid]::NewGuid().ToString('N')).exe"
    try {
        Write-Host "Downloading $url"
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

        $version = & $tmp --version
        if ($LASTEXITCODE -ne 0) {
            throw "batrak install: the downloaded binary doesn't run on this machine (exit code $LASTEXITCODE)"
        }

        Move-Item -Force -LiteralPath $tmp -Destination $exe
    } finally {
        Remove-Item -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
    }

    # Not Set-Content: Windows PowerShell's utf8 writes a BOM, which the JSON reader refuses.
    [IO.File]::WriteAllText((Join-Path $dir 'batrak.install.json'), "{ `"installer`": `"script`" }`n")

    Write-Host "Installed $version to $exe"
    Add-BatrakToPath $dir
}

function Add-BatrakToPath([string] $dir) {
    # The registry rather than GetEnvironmentVariable, which expands %VARS% and would write them back
    # expanded, changing the user's other entries.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
        $current = [string] $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
        $entries = @($current -split ';' | Where-Object { $_ })
        $present = $entries | Where-Object {
            [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $dir
        }
        if (-not $present) {
            $key.SetValue('Path', (($entries + $dir) -join ';'), 'ExpandString')
            # Writing a variable this way tells running programs that the environment changed; a direct
            # registry write doesn't. The variable never exists.
            [Environment]::SetEnvironmentVariable('BATRAK_INSTALL_NOTIFY', $null, 'User')
            Write-Host "Added $dir to your PATH. Open a new terminal for other windows to see it."
        }
    } finally {
        $key.Close()
    }

    if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $dir })) {
        $env:Path = "$env:Path;$dir"
    }
}

Install-Batrak
