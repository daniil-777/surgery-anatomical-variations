import {chromium} from '@playwright/test';
import {mkdir,writeFile,access} from 'node:fs/promises';
const root=process.env.VLA_DATA??'/tmp/viscera-vla/data';await mkdir(root,{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-angle=metal']});
const count=Number(process.env.EPISODES??24), start=Number(process.env.START??200);
async function recordEpisode(episode){
 try{await access(`${root}/episode-${String(episode).padStart(3,'0')}/episode.json`);console.log('existing',episode);return;}catch{}

 const page=await browser.newPage({viewport:{width:1152+(episode%3)*96,height:800}});page.setDefaultTimeout(20000);
 const dir=`${root}/episode-${String(episode).padStart(3,'0')}`;await mkdir(dir,{recursive:true});const rows=[];
 const save=async(stage,previous,label)=>{for(let frame=0;frame<3;frame++){
  const o=await page.evaluate(previous=>window.__visceraVisualObservation(previous),previous);
  const path=`${stage}-${frame}.jpg`;await writeFile(`${dir}/${path}`,Buffer.from(o.image.split(',')[1],'base64'));
  rows.push({...o,image:path,label,episode,previous,seed:1000+episode,stage});await page.waitForTimeout(90);
 }};
 try{
  await page.goto(`${process.env.MODEL_NAMES_URL??'http://127.0.0.1:5178/'}?mode=scene&scene=virtamed`);await page.locator('[data-scene-ready=true]').waitFor();
  const lab=page.getByRole('region',{name:'Camera planning lab',exact:true});await lab.getByRole('button',{name:'Camera planning lab',exact:false}).click();
  await lab.getByRole('textbox',{name:'Camera training seed',exact:true}).fill(String(1000+episode));
  if(episode%4){const editor=page.getByRole('region',{name:'Scene text-to-shape editor'});await editor.getByRole('textbox').fill(`liver-cirrhosis, severity ${(0.12+(episode-200)*.019).toFixed(3)}`);await editor.getByRole('button',{name:'Apply text',exact:true}).click();await page.waitForFunction(()=>document.body.innerText.includes('Applied shape and appearance to liver'));}
  await page.getByRole('slider',{name:'Operative residue',exact:true}).evaluate((el,value)=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},String((episode%4)*.15));
  await lab.getByRole('button',{name:'Use operative camera',exact:true}).click();await page.waitForTimeout(300);
  await save('initial','none','look');await lab.getByRole('button',{name:'Approach & grasp liver',exact:true}).click();
  await page.waitForFunction(()=>{const s=window.__visceraSceneSnapshot().automaticGrasp;if(s.phase==='blocked'||s.phase==='stopped')throw new Error(s.message);if(!window.__visceraCameraLabSnapshot().taskActive)throw new Error(window.__visceraCameraLabSnapshot().message);return ['learning','approaching'].includes(s.phase);},{},{timeout:100000});await save('arrived','look','grasp');
  await page.waitForFunction(()=>window.__visceraSceneSnapshot().automaticGrasp.phase==='holding',{},{timeout:90000});await save('held','grasp','release');
  await page.waitForFunction(()=>window.__visceraSceneSnapshot().automaticGrasp.phase==='complete',{},{timeout:60000});await save('released','release','finish');
  const evidence=await page.evaluate(()=>window.__visceraSceneSnapshot());await writeFile(`${dir}/episode.json`,JSON.stringify({episode,rows,success:true,evidence}));console.log('collected',episode,rows.length);
 }catch(error){await writeFile(`${dir}/failure.json`,JSON.stringify({episode,error:String(error),rows,state:await page.evaluate(()=>window.__visceraSceneSnapshot()),lab:await page.evaluate(()=>window.__visceraCameraLabSnapshot())}));await page.screenshot({path:`${dir}/failure.png`});console.log('failed',episode,String(error));}
 await page.close();
}
const concurrency=Math.min(2,Math.max(1,Number(process.env.CONCURRENCY??2)));
for(let episode=start;episode<start+count;episode+=concurrency)await Promise.all(Array.from({length:Math.min(concurrency,start+count-episode)},(_,i)=>recordEpisode(episode+i)));
await browser.close();
