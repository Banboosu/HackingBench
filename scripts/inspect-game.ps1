param([Parameter(Mandatory=$true)][string]$GameDirectory, [string]$CecilPath, [string[]]$Types = @('MainMenu','SaveFileManager','LocalDocumentsStorageMethod','SteamCloudStorageMethod','Game1'), [string[]]$BodyMethods = @())
$ErrorActionPreference = 'Stop'
if (-not $CecilPath) { $CecilPath = Join-Path $PSScriptRoot '..\vendor\hnpf-mcp\bridge\libs\Mono.Cecil.dll' }
Add-Type -Path (Resolve-Path $CecilPath)
$a = [Mono.Cecil.AssemblyDefinition]::ReadAssembly((Join-Path $GameDirectory 'Hacknet.exe'))
try {
  foreach ($t in $a.MainModule.Types) {
    if ($t.Name -in $Types) {
      "=== $($t.FullName)"
      $t.Fields | ForEach-Object { "FIELD $($_.FieldType.FullName) $($_.Name)" }
      foreach ($m in $t.Methods) {
        "METHOD $($m.FullName)"
        if ($m.HasBody -and ($m.Name -in $BodyMethods -or $m.Name -in @('HookUpCreationEvents','get_FullFolderPath','Load','Init') -or ($t.Name -eq 'MainMenu' -and $m.Name -like '*b__*'))) {
          $m.Body.Instructions | ForEach-Object { "  $_" }
        }
      }
    }
  }
} finally { $a.Dispose() }
