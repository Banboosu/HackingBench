import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { RUNTIME } from '../src/config.js';

export async function temporaryDirectory(prefix: string): Promise<string> {
  const root=path.join(RUNTIME,'test');
  await mkdir(root,{recursive:true});
  return mkdtemp(path.join(root,prefix));
}
