import { build } from 'esbuild';
await build({ entryPoints: ['server/index.ts'], bundle: true, platform: 'node', target: 'node24', format: 'esm', outfile: 'dist/server.mjs', packages: 'external', sourcemap: true });
