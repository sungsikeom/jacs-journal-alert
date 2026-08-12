$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogPath = Join-Path $RepoRoot "diagnostics\official-publisher-update.log"
Set-Location $RepoRoot

function Invoke-Collector {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Script,
        [string[]]$CollectorArgs = @()
    )

    $Listener = Get-NetTCPConnection -LocalPort 47821,47822,47823 -State Listen -ErrorAction SilentlyContinue
    if ($Listener) {
        throw "A journal receiver is already running on port $($Listener.LocalPort -join ', ')."
    }

    Write-Host "Collecting $Label from its official publisher page"
    & node $Script @CollectorArgs
    if ($LASTEXITCODE -ne 0) {
        throw "$Label collector failed with exit code $LASTEXITCODE."
    }
}

New-Item -ItemType Directory -Force (Split-Path $LogPath) | Out-Null
Start-Transcript -Path $LogPath -Append
try {
    Write-Host "[1/12] Updating the local repository"
    git pull --ff-only

    Write-Host "[2/12] JACS"
    Invoke-Collector -Label "JACS" -Script "scripts/receive_acs_collection.mjs"

    Write-Host "[3/12] Science"
    Invoke-Collector -Label "Science Research Articles" -Script "scripts/receive_science_collection.mjs"

    Write-Host "[4/12] Nature Communications"
    Invoke-Collector -Label "Nature Communications" -Script "scripts/receive_publisher_collection.mjs" -CollectorArgs @("nature")

    Write-Host "[5/12] JCTC"
    Invoke-Collector -Label "JCTC" -Script "scripts/receive_publisher_collection.mjs" -CollectorArgs @("jctc")

    Write-Host "[6/12] JCIM"
    Invoke-Collector -Label "JCIM" -Script "scripts/receive_publisher_collection.mjs" -CollectorArgs @("jcim")

    Write-Host "[7/12] JPCL"
    Invoke-Collector -Label "The Journal of Physical Chemistry Letters" -Script "scripts/receive_publisher_collection.mjs" -CollectorArgs @("jpcl")

    Write-Host "[8/12] Journal of Computational Chemistry"
    Invoke-Collector -Label "Journal of Computational Chemistry" -Script "scripts/receive_publisher_collection.mjs" -CollectorArgs @("jcc")

    Write-Host "[9/12] Angewandte"
    Invoke-Collector -Label "Angewandte" -Script "scripts/receive_publisher_collection.mjs" -CollectorArgs @("angew")

    Write-Host "[10/12] Chemical Science"
    Invoke-Collector -Label "Chemical Science" -Script "scripts/receive_publisher_collection.mjs" -CollectorArgs @("chemical-science")

    Write-Host "[11/12] Building publisher-only site data"
    & py -3 scripts/update_journals.py `
        --acs-file data/acs_articles.json `
        --science-file data/science_articles.json `
        --nature-file data/nature_communications_articles.json `
        --jctc-file data/jctc_articles.json `
        --jcim-file data/jcim_articles.json `
        --jpcl-file data/jpcl_articles.json `
        --jcc-file data/jcc_articles.json `
        --angew-file data/angew_articles.json `
        --chemical-science-file data/chemical_science_articles.json
    if ($LASTEXITCODE -ne 0) { throw "Publisher inventory merge failed." }

    Write-Host "[12/12] Publishing changed inventories"
    git add data/acs_articles.json data/science_articles.json data/nature_communications_articles.json `
        data/jctc_articles.json data/jcim_articles.json data/jpcl_articles.json data/jcc_articles.json data/angew_articles.json data/chemical_science_articles.json `
        data/articles.json data/seen_dois.json
    if (git diff --cached --quiet) {
        Write-Host "No publisher metadata changes were found."
        exit 0
    }

    $Date = Get-Date -Format "yyyy-MM-dd"
    git commit -m "Update official publisher inventories ($Date)"
    git push
}
finally {
    Stop-Transcript
}
