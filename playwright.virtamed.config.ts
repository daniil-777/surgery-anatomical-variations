import { defineConfig } from "@playwright/test";
import base from "./playwright.model-names.config";
export default defineConfig({...base,testMatch:["virtamed-scene.spec.ts"],reporter:[["list"],["json",{outputFile:"/tmp/virtamed-review/browser/results.json"}]],outputDir:"/tmp/virtamed-review/browser/test-results"});
