import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  ssr: {
    // node:sqlite is a Node built-in that Vite does not know about yet.
    external: ["node:sqlite"],
  },
});
