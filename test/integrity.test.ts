import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { REQUIRED_BINARIES, binaryFingerprints, verifyBinaries } from '../src/game/integrity.js';
import { temporaryDirectory } from './fixtures.js';

test('all isolation-sensitive binaries, not just the game exe, must match',async()=>{
  const root=await temporaryDirectory('integrity-');
  try {
    for(const name of REQUIRED_BINARIES){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),'fixture-'+name);}
    const hashes=await binaryFingerprints(root);await verifyBinaries(root,hashes);
    await writeFile(path.join(root,'BepInEx/core/BepInEx.Hacknet.dll'),'unexpected modification');
    await assert.rejects(()=>verifyBinaries(root,hashes),/Prepared binary changed/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('old/missing isolation fingerprints are refused',async()=>{
  await assert.rejects(()=>verifyBinaries('unused',undefined),/missing isolation fingerprints/);
});
