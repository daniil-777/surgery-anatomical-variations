import { defineConfig } from '@playwright/test';
import base from './playwright.model-names.config';
const output=process.env.SCENE_SHORTCUT_OUTPUT??'artifacts/scene-shortcuts/browser';
export default defineConfig({...base,testMatch:['scene-shortcuts.spec.ts'],timeout:90000,reporter:[['list'],['json',{outputFile:`${output}/results.json`}]],outputDir:`${output}/test-results`});
