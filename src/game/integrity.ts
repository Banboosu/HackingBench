import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { RUNTIME } from '../config.js';
import { assertNoLinks } from '../core/safety.js';

export const REQUIRED_BINARIES = ['Hacknet.exe','BepInEx/core/BepInEx.Hacknet.dll','BepInEx/plugins/PathfinderAPI.dll','BepInEx/plugins/HnpfMcpBridge.dll'] as const;
export async function binaryFingerprints(root: string): Promise<Record<string,string>> {
  const hashes: Record<string,string>={};
  for(const name of REQUIRED_BINARIES) {
    const file=path.join(root,name);await assertNoLinks(RUNTIME,file);
    hashes[name]=createHash('sha256').update(await readFile(file)).digest('hex');
  }
  return hashes;
}
export async function verifyBinaries(root: string, expected: unknown): Promise<void> {
  if(!expected || typeof expected!=='object')throw new Error('Prepared game is missing isolation fingerprints. Move runtime/game aside and run setup again.');
  const current=await binaryFingerprints(root);
  for(const name of REQUIRED_BINARIES) {
    if((expected as Record<string,unknown>)[name]!==current[name])throw new Error(`Prepared binary changed: ${name}. Refusing launch/rebuild; prepare a fresh project game copy.`);
  }
}
