param([string]$GameDirectory = (Join-Path $PSScriptRoot '..\runtime\game'))
$ErrorActionPreference = 'Stop'
# Offline IL contract test; no game launch, config/save writes, or pipe access.
Add-Type -Path (Join-Path $GameDirectory 'BepInEx\core\Mono.Cecil.dll')
$game = [Mono.Cecil.AssemblyDefinition]::ReadAssembly((Join-Path $GameDirectory 'Hacknet.exe'))
$bridge = [Mono.Cecil.AssemblyDefinition]::ReadAssembly((Join-Path $GameDirectory 'BepInEx\plugins\HnpfMcpBridge.dll'))
try {
    $board = $game.MainModule.Types | Where-Object FullName -eq 'Hacknet.MissionListingServer'
    if ($board.Methods | Where-Object Name -eq 'acceptMission') { throw 'Revisit this regression: game now has acceptMission.' }
    $draw = $board.Methods | Where-Object Name -eq 'draw'
    $native = @($draw.Body.Instructions)
    $start = -1
    for ($i = 0; $i -lt $native.Count; $i++) {
        if ($native[$i].OpCode.Name -eq 'stfld' -and $native[$i].Operand.FullName -eq 'Hacknet.ActiveMission Hacknet.OS::currentMission') {
            $start = $i
            break
        }
    }
    if ($start -lt 0) { throw 'Native Accept branch not found.' }
    $end = $start
    while ($end -lt $native.Count -and -not ($native[$end].OpCode.Name -eq 'stfld' -and $native[$end].Operand.FullName -eq 'System.Int32 Hacknet.MissionListingServer::state')) { $end++ }
    if ($end -ge $native.Count) { throw 'Native Accept branch end not found.' }
    $wanted = @(
        'Hacknet.ComputerLoader::readMission',
        'Hacknet.ActiveMission::sendEmail',
        'Hacknet.ActiveMission::ActivateSuppressedStartFunctionIfPresent',
        'Hacknet.MissionListingServer::removeMission'
    )
    function Effects($instructions) {
        @($instructions | Where-Object { $_.Operand -is [Mono.Cecil.MethodReference] -and $_.OpCode.Name -in @('call', 'callvirt') } |
            ForEach-Object { $_.Operand.DeclaringType.FullName + '::' + $_.Operand.Name } | Where-Object { $_ -notlike '*::get_Item' })
    }
    $nativeCalls = Effects $native[$start..$end]
    $executor = $bridge.MainModule.Types | Where-Object FullName -eq 'HnpfMcpBridge.Executor'
    $adapter = $executor.Methods | Where-Object Name -eq 'AcceptListing'
    if (-not $adapter) { throw 'AcceptListing missing (old adapter reproduces acceptMission-not-found failure).' }
    $adapterCalls = Effects $adapter.Body.Instructions
    if (($nativeCalls -join '|') -ne ($wanted -join '|') -or ($adapterCalls -join '|') -ne ($wanted -join '|')) {
        throw "Native/adapter Accept effects differ. Native=$nativeCalls Adapter=$adapterCalls"
    }
    $writes = @($adapter.Body.Instructions | Where-Object { $_.OpCode.Name -eq 'stfld' } | ForEach-Object { $_.Operand.FullName })
    if (($writes -join '|') -ne 'Hacknet.ActiveMission Hacknet.OS::currentMission|System.Int32 Hacknet.MissionListingServer::state') {
        throw "Unexpected adapter state writes: $writes"
    }
    'PASS: actual game has no acceptMission; adapter matches inline native Accept effects/order, with only currentMission and board UI state writes. No game launched.'
} finally { $game.Dispose(); $bridge.Dispose() }
