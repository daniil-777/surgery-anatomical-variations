import { defineConfig } from '@playwright/test';
import base from './playwright.model-names.config';
const output=process.env.SCENE_TEXT_OUTPUT??'/tmp/viscera-scene-text/browser';
export default defineConfig({...base,testMatch:['scene-text.spec.ts'],timeout:120000,reporter:[['list'],['json',{outputFile:`${output}/results.json`}]],outputDir:`${output}/test-results`});
