param(
    [string]$GameDirectory = (Join-Path $PSScriptRoot '..\runtime\game'),
    [string]$BridgePath = (Join-Path $GameDirectory 'BepInEx\plugins\HnpfMcpBridge.dll')
)
$ErrorActionPreference = 'Stop'
$gameRoot = (Resolve-Path $GameDirectory).Path
$bridgeFile = (Resolve-Path $BridgePath).Path
if ([Environment]::Is64BitProcess) {
    & "$env:WINDIR\SysWOW64\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -GameDirectory $gameRoot -BridgePath $bridgeFile
    exit $LASTEXITCODE
}
# Native regression using a temporary assembly fixture. Suppress ONLY the
# copied game's module initializer (BepInEx bootstrap), then allocate OS/Terminal
# without constructors and invoke the actual bridge reader. Production binaries,
# game config, pipes and the active run are never touched.
$fixture = Join-Path $PSScriptRoot ('..\runtime\terminal-reader-check\' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixture) | Out-Null
Add-Type -Path (Join-Path $gameRoot 'BepInEx\core\Mono.Cecil.dll')
$resolve = [System.ResolveEventHandler] {
    param($sender, $eventArgs)
    $name = ([Reflection.AssemblyName]::new($eventArgs.Name)).Name + '.dll'
    foreach ($dir in @($gameRoot, (Join-Path $gameRoot 'BepInEx\core'), (Join-Path $gameRoot 'BepInEx\plugins'))) {
        $file = Join-Path $dir $name
        if (Test-Path $file) { return [Reflection.Assembly]::LoadFrom($file) }
    }
    return $null
}
[AppDomain]::CurrentDomain.add_AssemblyResolve($resolve)
try {
    $copy = [Mono.Cecil.AssemblyDefinition]::ReadAssembly((Join-Path $gameRoot 'Hacknet.exe'))
    try {
        $moduleInit = $copy.MainModule.Types | Where-Object Name -eq '<Module>' | ForEach-Object { $_.Methods | Where-Object Name -eq '.cctor' }
        if (-not $moduleInit) { throw 'Expected BepInEx module initializer was not found.' }
        $moduleInit.Body.Instructions.Clear()
        $moduleInit.Body.ExceptionHandlers.Clear()
        $moduleInit.Body.Instructions.Add([Mono.Cecil.Cil.Instruction]::Create([Mono.Cecil.Cil.OpCodes]::Ret))
        $copy.Write((Join-Path $fixture 'Hacknet.exe'))
    } finally { $copy.Dispose() }
    $game = [Reflection.Assembly]::LoadFrom((Join-Path $fixture 'Hacknet.exe'))
    $bridge = [Reflection.Assembly]::LoadFrom($bridgeFile)
    $osType = $game.GetType('Hacknet.OS', $true)
    $terminalType = $game.GetType('Hacknet.Terminal', $true)
    $flags = [Reflection.BindingFlags]'Public, NonPublic, Instance'
    $os = [Runtime.Serialization.FormatterServices]::GetUninitializedObject($osType)
    $terminal = [Runtime.Serialization.FormatterServices]::GetUninitializedObject($terminalType)
    $history = [Collections.Generic.List[string]]::new()
    for ($i = 0; $i -lt 100; $i++) { $history.Add("fixture row $i") }
    $terminalType.GetField('history', $flags).SetValue($terminal, $history)
    $osType.GetField('terminal', $flags).SetValue($os, $terminal)
    $reader = $bridge.GetType('HnpfMcpBridge.Executor', $true).GetMethod('TerminalHistory', [Reflection.BindingFlags]'Static, NonPublic')
    $full = $reader.Invoke($null, [object[]]@($os, 120))
    if ($full['total'] -ne 100 -or $full['lines'].Count -ne 100) {
        throw "Full terminal history lost: expected total/count=100/100, got $($full['total'])/$($full['lines'].Count). history visibility: $($terminalType.GetField('history', $flags).Attributes)"
    }
    $tail = $reader.Invoke($null, [object[]]@($os, 15))
    if ($tail['total'] -ne 100 -or $tail['lines'].Count -ne 15 -or $tail['lines'][0] -ne 'fixture row 85' -or $tail['lines'][14] -ne 'fixture row 99') {
        throw 'Terminal tail is not the latest 15 rows with the full total.'
    }
    $history[99] += ' appended'
    $changed = $reader.Invoke($null, [object[]]@($os, 15))
    if ($changed['lines'][14] -ne 'fixture row 99 appended' -or $tail['lines'][14] -ne 'fixture row 99') {
        throw 'In-place writes or independent snapshots are broken.'
    }
    $history.Clear()
    $empty = $reader.Invoke($null, [object[]]@($os, 120))
    if ($empty['total'] -ne 0 -or $empty['lines'].Count -ne 0) { throw 'Terminal clear was not observed.' }
    'PASS: actual bridge reader + game Terminal fixture: full 100-row history, latest tail, in-place writes, independent snapshots, clear. No game launched or active run touched.'
} catch {
    throw $_.Exception.ToString()
} finally {
    [AppDomain]::CurrentDomain.remove_AssemblyResolve($resolve)
    # Loaded assemblies remain locked until this short-lived utility exits.
    # Keep the fixture under runtime; never clean or unlock production files.
}
