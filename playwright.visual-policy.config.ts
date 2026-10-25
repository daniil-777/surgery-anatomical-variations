import { defineConfig } from "@playwright/test";
import base from "./playwright.model-names.config";
const output=process.env.VLA_TEST_OUTPUT??"/tmp/viscera-vla/browser";
export default defineConfig({...base,testMatch:["visual-policy.spec.ts"],timeout:240000,expect:{timeout:30000},reporter:[["list"],["json",{outputFile:`${output}/results.json`}]],outputDir:`${output}/test-results`});
