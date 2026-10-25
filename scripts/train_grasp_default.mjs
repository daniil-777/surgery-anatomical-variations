// Reproduce the bundled option policy using its recorded coupled-scene input.
// Run: node scripts/train_grasp_default.mjs
import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'apps/studio/src/graspDefaultPolicy.json');
const source = JSON.parse(await readFile(destination, 'utf8'));
const temporary = await mkdtemp(path.join(tmpdir(), 'viscera-grasp-training-'));
try {
  const modulePath = path.join(temporary, 'grasp.mjs');
  await build({ entryPoints: [path.join(root, 'apps/studio/src/graspPolicy.ts')], outfile: modulePath, bundle: true, platform: 'node', format: 'esm' });
  const { trainGraspPolicy, GRASP_TARGET_HOLD_MM, GRASP_PROFILES } = await import(pathToFileURL(modulePath).href);
  const policy = trainGraspPolicy(source.trainingInput, 42);
  const result = {
    ...source,
    source: 'Recorded guarded liver contact and coupled scene; retrained with the v2 visible-lift objective using 12 real UCB episodes and three held-out stiffness checks.',
    trainingInputSha256: createHash('sha256').update(JSON.stringify(source.trainingInput)).digest('hex'),
    objective: { targetHoldMm: GRASP_TARGET_HOLD_MM, profiles: GRASP_PROFILES },
    policy,
  };
  await writeFile(destination, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ action: policy.action, profile: GRASP_PROFILES[policy.action], q: policy.q, visits: policy.visits, evaluation: policy.evaluation, trainingMs: policy.trainingMs }, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
