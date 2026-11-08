param([Parameter(Mandatory=$true)][string]$GameDirectory)
$ErrorActionPreference = 'Stop'
# Offline patches only, before this PROJECT COPY is executed.
$game = [IO.Path]::GetFullPath($GameDirectory)
$runtime = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\runtime'))
if (-not $game.StartsWith($runtime + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to patch a game outside project runtime.'
}
Add-Type -Path (Join-Path $game 'BepInEx\core\Mono.Cecil.dll')
$resolver = New-Object Mono.Cecil.DefaultAssemblyResolver
$resolver.AddSearchDirectory($game)
$resolver.AddSearchDirectory((Join-Path $game 'BepInEx\core'))
$resolver.AddSearchDirectory((Join-Path $game 'BepInEx\plugins'))
$reader = New-Object Mono.Cecil.ReaderParameters
$reader.AssemblyResolver = $resolver
$steamPatches = 0
$documentsPatches = 0
try {
  foreach ($relative in @('Hacknet.exe','BepInEx\plugins\PathfinderAPI.dll','BepInEx\core\BepInEx.Hacknet.dll')) {
    $file = Join-Path $game $relative
    $a = [Mono.Cecil.AssemblyDefinition]::ReadAssembly($file, $reader)
    try {
      $getEnv = $a.MainModule.ImportReference([Environment].GetMethod('GetEnvironmentVariable', [type[]]@([string])))
      if ($relative -eq 'Hacknet.exe') {
        $type = $a.MainModule.Types | Where-Object FullName -eq 'Hacknet.PlatformAPI.Storage.LocalDocumentsStorageMethod'
        $getter = $type.Methods | Where-Object Name -eq 'get_FullFolderPath'
        if (-not $getter -or -not $getter.HasBody) { throw 'Unsupported game: save-root getter not found.' }
        $body = $getter.Body
        $body.Instructions.Clear(); $body.ExceptionHandlers.Clear(); $body.Variables.Clear()
        $il = $body.GetILProcessor()
        $il.Append($il.Create([Mono.Cecil.Cil.OpCodes]::Ldstr, 'HACKINGBENCH_SAVE_DIR'))
        $il.Append($il.Create([Mono.Cecil.Cil.OpCodes]::Call, $getEnv))
        $il.Append($il.Create([Mono.Cecil.Cil.OpCodes]::Ret))
      }
      $allTypes = @($a.MainModule.Types)
      for ($n=0; $n -lt $allTypes.Count; $n++) { $allTypes += @($allTypes[$n].NestedTypes) }
      foreach ($t in $allTypes) {
        foreach ($m in $t.Methods) {
          if (-not $m.HasBody) { continue }
          $il = $m.Body.GetILProcessor()
          # Snapshot because document redirection inserts instructions.
          foreach ($i in @($m.Body.Instructions)) {
            if ($i.OpCode -ne [Mono.Cecil.Cil.OpCodes]::Call -or $i.Operand -isnot [Mono.Cecil.MethodReference]) { continue }
            $called = $i.Operand
            if ($called.DeclaringType.FullName -eq 'Steamworks.SteamAPI' -and $called.Name -eq 'Init' -and
                $called.Parameters.Count -eq 0 -and $called.ReturnType.FullName -eq 'System.Boolean') {
              $i.OpCode = [Mono.Cecil.Cil.OpCodes]::Ldc_I4_0; $i.Operand = $null; $steamPatches++
            }
            elseif ($called.DeclaringType.FullName -eq 'System.Environment' -and $called.Name -eq 'GetFolderPath' -and $called.Parameters.Count -eq 1) {
              # Redirect Documents/AppData lookups made by the game, HHBS and loader into a per-run tree.
              # Preserve the original instruction as a branch target; consume its enum argument.
              $i.OpCode = [Mono.Cecil.Cil.OpCodes]::Pop; $i.Operand = $null
              $name = $il.Create([Mono.Cecil.Cil.OpCodes]::Ldstr, 'HACKINGBENCH_DOCUMENTS')
              $call = $il.Create([Mono.Cecil.Cil.OpCodes]::Call, $getEnv)
              $il.InsertAfter($i,$name); $il.InsertAfter($name,$call)
              $documentsPatches++
            }
          }
        }
      }
      $a.Write($file + '.bench-patched')
    } finally { $a.Dispose() }
    Move-Item -LiteralPath ($file + '.bench-patched') -Destination $file -Force
  }
  if ($steamPatches -lt 1 -or $documentsPatches -lt 1) { throw 'Unsupported game: required Steam/path patches were not found. Refusing unsafe launch.' }
} finally { $resolver.Dispose() }
# Do NOT remove RemoteStorageRunning reads: Pathfinder's verified IL patch relies on those instructions.
Write-Output "Save root isolated; Steam Init disabled ($steamPatches call sites); special folders redirected ($documentsPatches call sites)."
