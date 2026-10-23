import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
const dir='artifacts/fat-quality-v3-2026-10-19/shadow-study';await mkdir(dir,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-gl=angle','--use-angle=metal']});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),results={cases:[],errors:[]};page.on('pageerror',e=>results.errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:5174/?mode=fat');
 for(const preset of ['visceral','omental']){
  await page.getByLabel('Fat depot',{exact:true}).selectOption(preset);await page.waitForFunction(()=>!document.querySelector('.fat-baking')&&document.querySelector('[data-fat-ready]'));
  for(const lighting of ['studio','grazing','surgical']){
   await page.getByLabel('Illumination',{exact:true}).selectOption(lighting);
   for(const enabled of [false,true]){
    await page.getByLabel('Surface self shadows',{exact:true}).setChecked(enabled);await page.waitForTimeout(300);
    const name=`${preset}-${lighting}-${enabled?'on':'off'}`;await page.screenshot({path:`${dir}/${name}.png`});
    results.cases.push({name,snapshot:JSON.parse(await page.locator('[data-fat-snapshot]').getAttribute('data-fat-snapshot'))});
   }
  }
 }
}finally{await writeFile(`${dir}/observations.json`,JSON.stringify(results,null,2));await browser.close();}
console.log(JSON.stringify({cases:results.cases.length,errors:results.errors}));
