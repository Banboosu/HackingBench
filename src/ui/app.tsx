import React, { useEffect, useRef, useState } from 'react';
import { Box, Text as InkText, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { configSchema, saveConfig, type BenchConfig } from '../config.js';
import { inspect, providerCatalog, type CatalogEntry, type Environment } from '../environment.js';
import { RunController, type RunResult } from '../runner.js';
import { prepareGame } from '../game/setup.js';
import { testProvider } from '../provider.js';
import { redact, terminalText } from '../core/safety.js';

// Preserve text rows under Yoga flex layout; shrinking text height causes overprinted labels.
const Text = ({children,...props}: React.ComponentProps<typeof InkText>) => <Box flexShrink={0}><InkText {...props}>{React.Children.map(children,child=>typeof child==='string' ? terminalText(child) : child)}</InkText></Box>;
const C = { cyan: '#50e6d3', green: '#7dcf85', orange: '#efb36a', muted: '#738a98', red: '#ed7b86' };
type LogLine = { type: 'system'|'action'|'observation'|'error'; text: string };
type Page = 'deck'|'config'|'catalog';
const time = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2,'0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2,'0')}`;
const Panel = ({ title, children, ...props }: React.PropsWithChildren<{title: string; width?: number|string; flexGrow?: number; height?: number; flexDirection?: 'row'|'column'}>) => <Box borderStyle="round" borderColor={C.muted} flexDirection="column" paddingX={1} flexShrink={0} {...props}><Text color={C.cyan} bold>{title}</Text>{children}</Box>;
interface Field { key: keyof BenchConfig | 'sessionKey'; label: string; help: string; options?: string[]; number?: boolean; }
const FIELDS: Field[] = [
  {key:'api',label:'API protocol',help:'Responses, Chat Completions, or Anthropic Messages. Must match your endpoint.',options:['openai-responses','openai-completions','anthropic-messages']},
  {key:'baseUrl',label:'API base URL',help:'HTTPS API root, e.g. https://api.example.com/v1. No key in the URL.'},
  {key:'model',label:'Model ID',help:'Exact upstream model ID. Press I on the main deck to import pi-provider metadata.'},
  {key:'keyEnv',label:'Key environment',help:'Name of the environment variable containing your key (recommended).'},
  {key:'sessionKey',label:'Session-only key',help:'Masked input. Kept in memory and injected into the child environment; never saved to config.'},
  {key:'gameSource',label:'Hacknet folder',help:'Your original game folder. Setup copies it; the source is never modified.'},
  {key:'piExecutable',label:'pi.exe',help:'Windows-native pi 1.5.0 executable; auto-detected when blank.'},
  {key:'wallTimeSeconds',label:'Wall budget (s)',help:'Real-time limit, including model thinking. Default 7200 seconds.',number:true},
  {key:'maxSteps',label:'Tool-call budget',help:'Maximum number of player tool calls.',number:true},
  {key:'maxTokens',label:'Token budget',help:'Total reported tokens including cached tokens; checked periodically, not a billing hard cap.',number:true},
  {key:'knowledge',label:'Knowledge',help:'L1 includes a concise command guide; L0 learns through game help.',options:['L1','L0']},
  {key:'observation',label:'Observation',help:'Images capture only the game framebuffer, never the desktop. Requires a vision model.',options:['text','text+image']},
  {key:'thinking',label:'Thinking level',help:'Set only if the selected endpoint/model supports reasoning.',options:['off','minimal','low','medium','high','xhigh','max']},
];

export function App({initialConfig, demo = false}: {initialConfig: BenchConfig; demo?: boolean}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size,setSize] = useState({cols:stdout.columns || 100,rows:stdout.rows || 32});
  const [config,setConfig] = useState(initialConfig);
  const [sessionKey,setSessionKey] = useState('');
  const [environment,setEnvironment] = useState<Environment>();
  const [page,setPage] = useState<Page>('deck');
  const [phase,setPhase] = useState(demo ? 'DEMO READY' : 'SCANNING');
  const [busy,setBusy] = useState(false);
  const [lines,setLines] = useState<LogLine[]>([{type:'system',text:demo ? 'SIMULATION MODE · no real game or API calls' : 'HackingBench online. Scanning Windows environment…'}]);
  const [assistant,setAssistant] = useState('');
  const [metrics,setMetrics] = useState({wallMs:0,steps:0,tokens:0,llmMs:0,toolMs:0});
  const [result,setResult] = useState<RunResult>();
  const [selected,setSelected] = useState(0);
  const [editing,setEditing] = useState<Field>();
  const [input,setInput] = useState('');
  const [catalog,setCatalog] = useState<CatalogEntry[]>([]);
  const [catalogIndex,setCatalogIndex] = useState(0);
  const controller = useRef<RunController | undefined>(undefined);
  const quitting = useRef(false);
  const effectiveKey = sessionKey || process.env[config.keyEnv] || '';
  const clean = (s: string) => terminalText(redact(s,[effectiveKey])).slice(-16000);
  const add = (text: string,type: LogLine['type'] = 'system') => setLines(old => [...old,{text:clean(text),type}].slice(-120));
  const scan = async (cfg = config) => {
    try {
      const env = await inspect(cfg); setEnvironment(env);
      setPhase(env.problems.length ? 'NEEDS ATTENTION' : 'READY');
      add(env.problems.length ? env.problems.join('\n') : `Windows ${env.runtime} · pi ${env.piVersion} · Hacknet ${env.dlc ? '+ DLC' : ''} detected.`);
      return env;
    } catch(e) { add((e as Error).message,'error'); setPhase('ERROR'); return undefined; }
  };
  useEffect(() => {
    const resize = () => setSize({cols:stdout.columns || 100,rows:stdout.rows || 32});
    stdout.on('resize',resize);
    if (!demo) void scan().then(env => {
      if (env && !process.env[initialConfig.keyEnv]) setPage('config');
    });
    return () => { stdout.off('resize',resize); controller.current?.stop(); };
  },[]);
  const job = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await work(); } catch(e) { add((e as Error).message,'error'); setPhase('ERROR'); }
    finally { setBusy(false); if (quitting.current) exit(); }
  };
  const start = () => void job(async () => {
    if (!demo) await saveConfig(config);
    setResult(undefined); setAssistant(''); setMetrics({wallMs:0,steps:0,tokens:0,llmMs:0,toolMs:0});
    const run = new RunController(); controller.current = run;
    run.on('phase',setPhase); run.on('log',(s:string) => add(s));
    run.on('action',(s:string) => add(s,'action'));
    run.on('observation',(s:string) => add(s,'observation'));
    run.on('assistant',(s:string) => setAssistant(old => clean((old+s).slice(-3000))));
    run.on('metrics',setMetrics);
    const done = await run.run(config,effectiveKey,demo);
    setResult(done); setPhase(done.demo ? 'DEMO FINISHED' : done.status.toUpperCase());
    add(`${done.demo ? 'DEMO' : 'RUN'} ${done.status} · ${done.steps} steps · ${time(done.wallMs)}`);
    controller.current = undefined;
  });
  const save = () => void job(async () => {
    await saveConfig(config); add('Configuration saved. No API key was written to disk.');
    setPage('deck'); await scan(config);
  });
  const quit = () => {
    if (busy) { quitting.current=true; controller.current?.stop(); add('Stopping owned processes before exit…'); }
    else exit();
  };
  useInput((keyInput,key) => {
    if (key.ctrl && keyInput === 'c') { quit(); return; }
    if (editing) {
      if (key.escape) { setEditing(undefined); setInput(''); }
      return;
    }
    if (page === 'catalog') {
      if (key.escape) setPage('deck');
      else if (key.upArrow) setCatalogIndex(i => Math.max(0,i-1));
      else if (key.downArrow) setCatalogIndex(i => Math.min(catalog.length-1,i+1));
      else if (key.return && catalog[catalogIndex]) {
        const entry = catalog[catalogIndex]!;
        setConfig(old => ({...old,api:entry.api,baseUrl:entry.baseUrl,model:entry.model}));
        add(`Imported ${entry.provider}/${entry.model}. Credentials and executable config were NOT imported.`);
        setPage('config');
      }
      return;
    }
    if (page === 'config') {
      if (key.escape) setPage('deck');
      else if (key.ctrl && keyInput === 's') save();
      else if (key.upArrow) setSelected(i => (i+FIELDS.length-1)%FIELDS.length);
      else if (key.downArrow || key.tab) setSelected(i => (i+1)%FIELDS.length);
      else if (key.return || key.leftArrow || key.rightArrow) {
        const field = FIELDS[selected]!;
        if (field.options) {
          const index = field.options.indexOf(String(config[field.key as keyof BenchConfig]));
          const next = field.options[(index + (key.leftArrow ? -1 : 1) + field.options.length)%field.options.length]!;
          setConfig(old => ({...old,[field.key]:next}));
        } else { setEditing(field); setInput(field.key === 'sessionKey' ? '' : String(config[field.key])); }
      }
      return;
    }
    if (keyInput.toLowerCase() === 'q') { quit(); return; }
    if (key.escape && busy) { controller.current?.stop(); add('Stop requested. Cleanup may take a few seconds.'); return; }
    if (busy) return;
    switch(keyInput.toLowerCase()) {
      case 's': start(); break;
      case 'c': setPage('config'); break;
      case 'd': void job(async () => { setPhase('SCANNING'); await scan(); }); break;
      case 'p': if (!demo) void job(async () => { setPhase('SETUP'); await prepareGame(config,add); await scan(); }); break;
      case 't': if (!demo) void job(async () => {
        setPhase('TESTING API'); const env=await inspect(config);
        if (!env.pi) throw new Error('pi.exe not found.');
        add(await testProvider(config,effectiveKey,env.pi)); setPhase('API READY');
      }); break;
      case 'i': void job(async () => {
        const entries = await providerCatalog(); setCatalog(entries); setCatalogIndex(0);
        if (!entries.length) add('No supported pi-provider catalog entries found. Configure your endpoint manually.');
        else setPage('catalog');
      }); break;
    }
  });
  const submit = (value: string) => {
    const field = editing!;
    try {
      if (field.key === 'sessionKey') { setSessionKey(value); }
      else {
        const changed = {...config,[field.key]:field.number ? Number(value) : value.trim()};
        const valid = configSchema.parse(changed); setConfig(valid);
      }
      setEditing(undefined); setInput('');
    } catch { add('Invalid value. Check the field format/range.','error'); }
  };
  const width = Math.max(40,size.cols);
  const height = Math.max(24,size.rows-1);
  const logHeight = Math.max(1,height-20);
  const entries = lines.flatMap(l => l.text.split('\n').map(text => ({type:l.type,text}))).slice(-logHeight);
  const visibleFields = Math.max(4,height-13);
  const fieldStart = Math.max(0,Math.min(selected-Math.floor(visibleFields/2),FIELDS.length-visibleFields));
  const compact = width < 90 || height < 28;
  return <Box flexDirection="column" width={width} height={height} paddingX={1}>
    <Box justifyContent="space-between" marginBottom={1} flexShrink={0}>
      <Box flexDirection="column"><Text color={C.cyan} bold>╱╱ HACKINGBENCH <InkText color={C.muted}>v0.1</InkText></Text><Text color={C.muted}>AUTONOMOUS HACKNET SPEEDRUN LAB</Text></Box>
      <Box flexDirection="column" alignItems="flex-end"><Text color={demo ? C.orange : C.green}>{demo ? '● SIMULATION' : '● LOCAL / TOOL-RESTRICTED'}</Text><Text color={busy ? C.orange : C.cyan}>{phase}</Text></Box>
    </Box>
    {page === 'config' ? <Panel title="LINK CONFIGURATION // 配置" flexGrow={1}>
      <Text color={C.muted}>↑↓ select · Enter edit/cycle · Ctrl+S save · Esc back</Text>
      <Box flexDirection="column" marginY={1}>
        {FIELDS.slice(fieldStart,fieldStart+visibleFields).map((f,i) => {
          const focused=fieldStart+i===selected;
          let value = f.key === 'sessionKey' ? (sessionKey ? '•••••••• [memory only]' : '[not set]') : String(config[f.key]);
          if (!value) value='[auto-detect]';
          if (f.key==='keyEnv' && process.env[config.keyEnv]) value+=' [available]';
          return <Text key={f.key} color={focused ? C.cyan : undefined} wrap="truncate-end">{focused ? '› ' : '  '}{f.label.padEnd(20)} {value}</Text>;
        })}
      </Box>
      <Text color={C.orange}>{FIELDS[selected]!.help}</Text>
      <Box marginTop={1} flexDirection="column">
        {editing ? <><Text color={C.cyan}>{editing.label}:</Text><TextInput value={input} onChange={setInput} onSubmit={submit} mask={editing.key==='sessionKey' ? '*' : undefined}/></> : <Text color={C.muted}>Keys stay in memory/env. Only non-secret settings are saved under runtime/.</Text>}
      </Box>
    </Panel> : page === 'catalog' ? <Panel title="PI-PROVIDER CATALOG // metadata only" flexGrow={1}>
      <Text color={C.muted}>↑↓ select · Enter import · Esc back · no credentials imported</Text>
      {catalog.slice(Math.max(0,catalogIndex-4),Math.max(0,catalogIndex-4)+Math.max(5,height-12)).map((e,i) => {
        const idx=Math.max(0,catalogIndex-4)+i;
        return <Text key={`${e.provider}/${e.model}/${i}`} color={idx===catalogIndex ? C.cyan : undefined} wrap="truncate-end">{idx===catalogIndex ? '› ' : '  '}{e.provider} / {e.model}</Text>;
      })}
    </Panel> : <>
      <Box flexDirection="row" flexGrow={1}>
        {!compact && <Panel title="OPERATOR" width={28}>
          <Text color={C.muted}>MODEL</Text><Text wrap="truncate-end">{demo ? 'Synthetic preview' : config.model}</Text>
          <Text color={C.muted}>PROTOCOL</Text><Text>{config.api}</Text>
          <Box marginY={1} flexDirection="column"><Text color={C.muted}>CAMPAIGN</Text><Text>Original / fresh account</Text><Text>{environment?.dlc ? 'DLC files detected' : 'DLC: awaiting detection'}</Text></Box>
          <Text color={C.muted}>OBSERVATION</Text><Text>{config.knowledge} · {config.observation}</Text>
          <Box marginY={1} flexDirection="column"><Text color={C.muted}>SECURITY</Text><Text color={C.green}>No shell / host files</Text><Text>Separate saves + game</Text><Text>Steam/cloud disabled</Text><Text color={C.orange}>Not an OS sandbox</Text></Box>
          <Text color={C.muted}>CREDENTIAL</Text><Text color={effectiveKey ? C.green : C.orange}>{demo ? 'Not required' : effectiveKey ? 'Available in memory/env' : 'Not configured'}</Text>
        </Panel>}
        <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
          <Panel title="LIVE TERMINAL" flexGrow={1}>
            {entries.map((l,i) => <Text key={i} wrap="truncate-end" color={l.type==='action' ? C.cyan : l.type==='error' ? C.red : l.type==='system' ? C.muted : undefined}>{l.type==='action' ? '❯ ' : l.type==='observation' ? '  ' : '· '}{l.text}</Text>)}
            {assistant && <Box marginTop={1}><Text color={C.muted} wrap="truncate-end">AGENT › {assistant.split('\n').slice(-1)[0]}</Text></Box>}
          </Panel>
          <Panel title={result ? 'RUN SUMMARY' : 'MISSION // BASE CAMPAIGN (EXPERIMENTAL)'} height={5}>
            <Text wrap="truncate-end">{result ? `${result.demo ? 'SIMULATED · not scored' : result.status.toUpperCase()} / ${result.model}` : 'Reach the original campaign ending. The runner checks completion independently.'}</Text>
            <Text color={C.muted} wrap="truncate-end">{result?.error || (result && !result.demo ? `Artifact: runtime/runs/${result.runId}/result.json` : 'Experimental judge · DLC not scored · real-time game')}</Text>
          </Panel>
        </Box>
      </Box>
      <Box borderStyle="single" borderColor={C.muted} paddingX={1} justifyContent="space-between" flexShrink={0}>
        <Text color={C.cyan}>TIME {time(metrics.wallMs)} / {time(config.wallTimeSeconds*1000)}</Text>
        <Text>STEP {metrics.steps}/{config.maxSteps}</Text><Text>TOKENS {metrics.tokens.toLocaleString()}</Text>
        {!compact && <Text color={C.muted}>LLM {time(metrics.llmMs)} · TOOL {time(metrics.toolMs)}</Text>}
      </Box>
    </>}
    {compact && <Text color={C.orange} wrap="truncate-end">Not an OS sandbox · experimental base-campaign adapter</Text>}
    <Box marginTop={1} flexShrink={0}><Text color={C.cyan}>{busy ? '[Esc] Stop owned run   [Q] Quit after cleanup' : page==='deck' ? '[S] Start   [C] Configure   [T] Test API   [P] Prepare   [D] Doctor   [I] Import   [Q] Quit' : '[Esc] Back   [Ctrl+C] Quit'}</Text></Box>
  </Box>;
}
