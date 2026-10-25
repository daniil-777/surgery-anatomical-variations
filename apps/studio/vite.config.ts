import { interfaceTypography } from "./interfaceTypography";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** The texture lab as its own page: dist/textures.html is index.html with its title, description and
 * <meta name="viscera-mode" content="textures"> (read by main.tsx), sharing every asset. */
function texturesPage(): Plugin {
  let outDir = "dist";
  return {
    name: "viscera-textures-page",
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    writeBundle() {
      const index = readFileSync(resolve(outDir, "index.html"), "utf8");
      const page = index
        .replace(/<title>[^<]*<\/title>/, "<title>VISCERA — Texture lab</title>")
        .replace(/content="An original procedural anatomy workspace[^"]*"/, 'content="Real tissue detail from licensed surgical photographs over VISCERA\'s procedural organ materials: the texture lab."')
        .replace("</head>", '    <meta name="viscera-mode" content="textures" />\n  </head>');
      if (page === index) throw new Error("textures.html: index.html did not have the expected title and head");
      writeFileSync(resolve(outDir, "textures.html"), page);
      writeFileSync(resolve(outDir, "tissues.html"), index
        .replace(/<title>[^<]*<\/title>/, "<title>VISCERA — Layered tissue lab</title>")
        .replace("</head>", '    <meta name="viscera-mode" content="tissues" />\n  </head>'));
      writeFileSync(resolve(outDir, "fat.html"), index
        .replace(/<title>[^<]*<\/title>/, "<title>VISCERA — Adipose lab</title>")
        .replace("</head>", '    <meta name="viscera-mode" content="fat" />\n  </head>'));
      writeFileSync(resolve(outDir, "blood.html"), index
        .replace(/<title>[^<]*<\/title>/, "<title>VISCERA — Blood & fluid lab</title>")
        .replace("</head>", '    <meta name="viscera-mode" content="blood" />\n  </head>'));
      writeFileSync(resolve(outDir, "404.html"), index);
    },
  };
}
// VISCERA_BASE: where the built app is served from ("/" by default; the public copy uses "./" and sits at any path).
// VISCERA_SOURCEMAP=0 leaves the source maps out (the public copy).
export default defineConfig({
  base: process.env.VISCERA_BASE ?? "/",
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), texturesPage()],
  css: { postcss: { plugins: [interfaceTypography()] } },
  resolve: {
    alias: {
      "@viscera/ui": fileURLToPath(
        new URL("../../packages/ui/src/index.tsx", import.meta.url),
      ),
      "@viscera/render": fileURLToPath(
        new URL("../../packages/render/src/index.tsx", import.meta.url),
      ),
      "@viscera/geometry": fileURLToPath(
        new URL("../../packages/geometry/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: { "^/api/": { target: process.env.VISCERA_API_URL ?? "http://127.0.0.1:8000", changeOrigin: true } },
  },
  build: {
    target: "es2022",
    sourcemap: process.env.VISCERA_SOURCEMAP !== "0",
    copyPublicDir: process.env.VISCERA_COPY_PUBLIC !== "0",
    // three.js and React change rarely: their own files stay cached across releases of the app
    rollupOptions: { output: { manualChunks: { three: ["three"], react: ["react", "react-dom"] } } },
  },
});
