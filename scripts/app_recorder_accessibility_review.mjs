import { chromium } from '@playwright/test';
import fs from 'node:fs';
const out=process.env.APP_RECORDER_OUTPUT??'artifacts/app-recorder-all-apps-2026-10-26';
const axeFile=process.env.AXE_SOURCE;
if(!axeFile || !fs.existsSync(axeFile)) throw new Error('Set AXE_SOURCE to a local axe-core axe.min.js file.');
fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const results=[];
try {
 for(const width of [375,768,1440]) {
  const page=await browser.newPage({viewport:{width,height:1000}});
  await page.goto(new URL('recorder/',process.env.LAB_RECORDER_URL??'http://127.0.0.1:5193/').href);await page.locator('dialog[open]').waitFor();
  await page.addScriptTag({path:axeFile});
  const r=await page.evaluate(()=>window.axe.run('dialog',{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));
  results.push({width,violations:r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({html:n.html,summary:n.failureSummary}))})),incomplete:r.incomplete.map(v=>v.id)});
  await page.screenshot({path:`${out}/recorder-a11y-${width}.png`});await page.close();
 }
 fs.writeFileSync(`${out}/accessibility.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));if(results.some(r=>r.violations.length))process.exitCode=1;
} finally {await browser.close();}
