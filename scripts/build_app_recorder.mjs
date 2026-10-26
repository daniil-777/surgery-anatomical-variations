#!/usr/bin/env node
// One portable recorder bundle, built from the same engine and panel as Viscera.
// Commit it for static consumers; --check fails if source and distributed assets diverge.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'apps/studio/public/recorder');
const source = path.join(root, 'apps/studio/src/recording/app');
const outputs = new Map();
for (const [entry, name, format] of [['main.tsx','recorder.js','iife'], ['launcher.ts','launcher.js','iife']]) {
  const result = await build({ entryPoints:[path.join(source, entry)], outfile:path.join(out,name), bundle:true,
    format, platform:'browser', target:'es2022', minify:true, write:false, jsx:'automatic',
    define:{ 'process.env.NODE_ENV':'"production"' }, legalComments:'eof' });
  for (const file of result.outputFiles) outputs.set(path.basename(file.path), Buffer.from(file.contents));
}
outputs.set('launcher.css', fs.readFileSync(path.join(source,'launcher.css')));
outputs.set('index.html', Buffer.from(`<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>App recorder — Generation Lab</title><link rel="icon" href="data:,"><link rel="stylesheet" href="./recorder.css"><script src="./recorder.js" defer></script></head><body><div id="root"></div></body></html>\n`));
outputs.set('manifest.json', Buffer.from(JSON.stringify({ schema:'generation-lab-recorder/v1', source:'Viscera VideoRecorder + VideoRecorderPanel',
  files:Object.fromEntries([...outputs].map(([file, bytes]) => [file,{bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}])) },null,2)+'\n'));
if (process.argv.includes('--check')) {
  for (const [file, bytes] of outputs) if (!fs.existsSync(path.join(out,file)) || !bytes.equals(fs.readFileSync(path.join(out,file)))) throw new Error(`Rebuild recorder: ${file} is stale`);
  console.log('Portable recorder matches source.');
} else {
  fs.mkdirSync(out,{recursive:true});
  for (const [file,bytes] of outputs) fs.writeFileSync(path.join(out,file),bytes);
  console.log(`Portable recorder: ${outputs.size} files, ${[...outputs.values()].reduce((n,b)=>n+b.length,0)} bytes`);
}
