import { join } from 'path';

const dist = join(import.meta.dir, 'dist');
const port = Number(process.env.PORT) || 5180;

Bun.serve({
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(join(dist, path === '/' ? 'index.html' : path.slice(1)));
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(join(dist, 'index.html'))); // SPA fallback
  },
});
console.log(`hello-pwa serving http://localhost:${port}`);
