import {test,expect} from '@playwright/test';
import {SURGICAL_PROMPT_TIPS} from '../../apps/studio/src/AtlasPromptTips';
test('loading a prompt is not reported as applied until the model changes',async({page})=>{
 let release=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;});
 await page.route(/(?:models\/text-compiler\/tables\.json|api\/atlas\/compile)(?:\?|$)/,async route=>{await gate;await route.continue();});
 await page.goto('/');
 await expect(page.getByRole('textbox',{name:'Describe an anatomy variation',exact:true})).toBeEnabled();
 await expect(page.locator('.atlas-dimensions')).toContainText('mm');
 const before=(await page.locator('.atlas-dimensions').textContent())!;
 await page.getByTestId('atlas-prompt-tips-trigger').click();
 await page.getByLabel('Presentation mode (stay open)').check();
 await page.getByTestId('atlas-tip-load-liver-mm-sizing').click();
 await expect(page.getByTestId('atlas-tip-apply-liver-mm-sizing')).toHaveText('Apply to 3D Organ');
 await expect(page.locator('.atlas-dimensions')).toHaveText(before);
 await page.getByTestId('atlas-tip-apply-liver-mm-sizing').click();
 try {
  await expect(page.getByTestId('atlas-tip-apply-liver-mm-sizing')).toBeDisabled();
  await expect(page.getByTestId('atlas-tip-apply-liver-mm-sizing')).toHaveText('Apply to 3D Organ');
 } finally {release();}
 await expect(page.getByTestId('atlas-tip-apply-liver-mm-sizing')).toHaveText('Applied to 3D Organ');
 await expect(page.locator('.atlas-dimensions')).toContainText('256.0 × 175.0 × 162.0');
 await page.getByRole('textbox',{name:'Describe an anatomy variation',exact:true}).fill('not a supported instruction');
 await expect(page.getByTestId('atlas-tip-apply-liver-mm-sizing')).toHaveText('Apply to 3D Organ');
 await page.getByRole('button',{name:'Apply text instruction',exact:true}).click();
 await expect(page.locator('.atlas-text-feedback.unsupported')).toBeVisible();
 await expect(page.locator('.atlas-dimensions')).toContainText('256.0 × 175.0 × 162.0');
});
test('all 28 built-in organ prompts apply through their actual buttons',async({page},info)=>{
 test.setTimeout(300000);
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');
 await expect(page.getByRole('textbox',{name:'Describe an anatomy variation',exact:true})).toBeEnabled();
 await page.getByTestId('atlas-prompt-tips-trigger').click();
 await page.getByLabel('Presentation mode (stay open)').check();
 const results=[];
 for(const tip of SURGICAL_PROMPT_TIPS){
  await page.getByTestId(`atlas-tips-tab-${tip.category==='multi-organ'?'multi-organ':'all'}`).click();
  await page.getByTestId(`atlas-tip-apply-${tip.id}`).click();
  await expect(page.getByRole('textbox',{name:'Describe an anatomy variation',exact:true})).toBeEnabled();
  await expect(page.locator('.atlas-text-feedback')).not.toContainText('Unsupported requests stay unapplied.');
  const feedback=await page.locator('.atlas-text-feedback').innerText();
  const alerts=await page.getByRole('alert').allTextContents();
  results.push({id:tip.id,feedback,alerts});
  expect.soft(alerts,tip.id).toEqual([]);
  await expect.soft(page.locator('.atlas-text-feedback.unsupported'),`${tip.id}: ${feedback}`).toHaveCount(0);
  console.log(tip.id,alerts.length?'FAIL':feedback);
 }
 expect(errors).toEqual([]);
 await info.attach('prompt-results',{body:JSON.stringify(results,null,2),contentType:'application/json'});
 await page.screenshot({path:info.outputPath('all-prompts.png')});
});
