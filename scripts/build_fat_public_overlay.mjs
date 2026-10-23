/** Refresh the local fat lab/shared entrypoints without replacing existing atlas
 * snapshots, API configuration or another lab's separately generated datasets.
 * Full distribution builds still use build_public_copy.mjs. */
import { build } from 'vite';
import { mkdtemp, mkdir, cp, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.resolve(root,process.argv[2]??'../anatomy');
const previous=JSON.parse(await readFile(path.join(out,'build.json'),'utf8'));
const temporary=await mkdtemp(path.join(os.tmpdir(),'viscera-fat-v3-'));
try {
  await build({configFile:path.join(root,'apps/studio/vite.config.ts'),base:'./',
    build:{outDir:temporary,emptyOutDir:true,copyPublicDir:false,sourcemap:false}});
  await mkdir(path.join(out,'assets'),{recursive:true});
  await cp(path.join(temporary,'assets'),path.join(out,'assets'),{recursive:true});
  await cp(path.join(root,'apps/studio/public/fat-lab'),path.join(out,'fat-lab'),{recursive:true});
  for(const file of ['index.html','textures.html','fat.html']) await cp(path.join(temporary,file),path.join(out,file));
  const builtAt=new Date().toISOString();let files=0,bytes=0;
  async function count(directory){for(const item of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,item.name);if(item.isDirectory())await count(file);else{files++;bytes+=(await stat(file)).size;}}}
  await count(out);
  await writeFile(path.join(out,'build.json'),JSON.stringify({...previous,builtAt,files,bytes,fatLab:{
    ...previous.fatLab,version:'fat-procedural-v3',builtAt,geometryVersion:'viscera-fat-geometry-v3',
    textureVersion:'viscera-fat-texture-v3',materialVersion:'viscera-fat-triplanar-v3',
    qualityEvidence:'viscera/artifacts/fat-quality-v3-2026-10-19',
    referenceLicense:'Per-reference attribution; DSAD repository/publication usage wording differs',
    buildMode:'Compiled shared entrypoints and fat assets overlaid; existing public datasets preserved',
  }},null,2)+'\n');
  console.log(JSON.stringify({out,builtAt,files,bytes}));
} finally { await rm(temporary,{recursive:true,force:true}); }
