import { expect,test,type Page } from '@playwright/test';
import { readFileSync,writeFileSync } from 'node:fs';
async function snap(page:Page){return JSON.parse((await page.getByTestId('playground-diagnostics').getAttribute('data-snapshot'))!);}
const ready=(page:Page)=>page.waitForResponse(r=>r.url().endsWith('/api/physics/playground')&&r.request().method()==='POST'&&r.status()!==503);
async function open(page:Page){
 await page.goto('/');const b=page.getByRole('button',{name:'Physics lab',exact:true});await expect(b).toBeEnabled({timeout:60000});const r=ready(page);await b.click();const response=await r;expect(response.status(),await response.text()).toBe(200);await expect(page.getByTestId('playground-diagnostics')).toHaveAttribute('data-snapshot',/.+/);await expect(page.getByText('Physics AI v2 · varied loading histories')).toBeVisible();return response.json();
}
async function apply(page:Page){const r=ready(page);await page.getByRole('button',{name:'Apply material',exact:true}).click();return r;}

test('live AI v2 imports three varied histories and transfers accepted parameters to the displayed liver',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const initial=await open(page);expect(initial.learning.version).toBe('liver-inverse-sls-2.0.0');expect(initial.learning.accepted_for_application).toBe(true);
 const status=await(await page.request.get('/api/physics/status')).json();expect(status.model_version).toBe('liver-inverse-sls-2.0.0');
 await page.getByRole('button',{name:'Gravity',exact:true}).click();await page.getByRole('button',{name:'Pause physics',exact:true}).click();
 const entries:unknown[]=[];
 for(const kind of ['ramp_hold_release','triangle','cyclic']){
  const path=`tests/fixtures/physics-ai-v2/${kind}.json`,observation=JSON.parse(readFileSync(path,'utf8'));
  const details=page.locator('details.physics-calibration');if(!(await details.evaluate(e=>(e as HTMLDetailsElement).open)))await details.locator('summary').click();
  await page.getByLabel('Calibration JSON').setInputFiles(path);
  await expect(page.getByText(`Loaded · unverified: ${kind}.json`)).toBeVisible();
  const response=await apply(page);expect(response.status(),await response.text()).toBe(200);const result=await response.json();
  expect(result.learning.version).toBe('liver-inverse-sls-2.0.0');expect(result.learning.accepted_for_application).toBe(true);expect(result.learning.observation_origin).toBe('user_supplied_calibration_unverified');expect(result.learning.observation_provenance).toBe(observation.provenance);
  await expect.poll(async()=>(await snap(page)).parameters.young_pa).toBeCloseTo(result.parameters.young_pa,8);
  const snapshot=await snap(page);expect(snapshot.source.realized_id).toBe(result.source.realized_id);expect(snapshot.metrics.finite_state).toBe(true);expect(snapshot.metrics.minimum_jacobian).toBeGreaterThan(0);
  for(const key of ['young_pa','relaxation_fraction','relaxation_time_s']){expect(snapshot.parameters[key]).toBe(result.parameters[key]);expect(result.learning.parameter_intervals_90[key].upper).toBeGreaterThanOrEqual(result.parameters[key]);expect(result.learning.parameter_intervals_90[key].lower).toBeLessThanOrEqual(result.parameters[key]);}
  await expect(page.getByText(/synthetic 90% interval/).first()).toBeVisible();await expect(page.getByText(/Calibration source \(unverified\):/)).toContainText(observation.provenance);
  entries.push({kind,parameters:result.parameters,learning:result.learning,source:result.source,snapshot});
 }
 await page.screenshot({path:info.outputPath('01-v2-cyclic-calibration.png'),fullPage:true});
 const before=await snap(page);await page.getByLabel('Parameter source').selectOption('manual');await page.getByRole('slider',{name:'Young’s modulus',exact:true}).fill('6500');
 expect((await snap(page)).parameters.young_pa).toBe(before.parameters.young_pa);
 const response=await apply(page);expect(response.status(),await response.text()).toBe(200);const manual=await response.json();expect(manual.learning.source).toBe('manual');await expect.poll(async()=>(await snap(page)).parameters.young_pa).toBe(6500);
 await page.screenshot({path:info.outputPath('02-v2-manual-material.png'),fullPage:true});expect(errors).toEqual([]);writeFileSync(info.outputPath('ai-v2-live-metrics.json'),JSON.stringify({status,initial:{learning:initial.learning,parameters:initial.parameters},entries,manual:{learning:manual.learning,parameters:manual.parameters,snapshot:await snap(page)}},null,2));
});

test('live AI v2 refuses an unidentifiable elastic-only observation instead of applying it',async({page},info)=>{
 const initial=await open(page);await page.getByRole('button',{name:'Pause physics',exact:true}).click();
 const observation=JSON.parse(readFileSync('tests/fixtures/physics-ai-v2/ramp_hold_release.json','utf8'));
 observation.force_n=observation.displacement_mm.map((x:number)=>4000*x/observation.reference_length_mm*observation.reference_area_mm2*1e-6);observation.provenance='Synthetic QA elastic-only history: no identifiable relaxation time; not measured tissue.';
 await page.locator('details.physics-calibration > summary').click();await page.getByLabel('Calibration JSON').setInputFiles({name:'elastic-only.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(observation))});
 const response=await apply(page),payload=await response.json();expect(response.status()).toBe(422);await expect(page.getByRole('alert')).toContainText(/identif|application|calibration|rejected/i);
 await page.screenshot({path:info.outputPath('03-v2-rejected-weak-calibration.png'),fullPage:true});
 writeFileSync(info.outputPath('ai-v2-rejection.json'),JSON.stringify({initial_model:initial.learning.version,observation,status:response.status(),payload},null,2));
});
