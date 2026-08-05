$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RepoRoot

Write-Host "[1/5] Updating local repository"
git pull --ff-only

Write-Host "[2/5] Collecting the complete ACS JACS list in regular Google Chrome"
node scripts/receive_acs_collection.mjs

Write-Host "[3/5] Merging ACS inclusion data with Crossref metadata"
python scripts/update_journals.py --acs-file data/acs_articles.json

Write-Host "[4/5] Verifying changed files"
git add data/acs_articles.json data/articles.json data/seen_dois.json
if (git diff --cached --quiet) {
    Write-Host "No journal metadata changes were found."
    exit 0
}

Write-Host "[5/5] Publishing verified metadata"
$Date = Get-Date -Format "yyyy-MM-dd"
git commit -m "Update ACS verified JACS metadata ($Date)"
git push
