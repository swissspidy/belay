#!/usr/bin/env node
/**
 * The learned-classifier quickstart: a page that triages support messages with
 * @swissspidy/belay-learn, and the backend endpoint its cloud runner calls.
 *
 *   npm install && npm run build          # once, from the repository root
 *   node examples/learned-quickstart/server.mjs
 *
 * Then open http://localhost:8787. With Anthropic credentials (ANTHROPIC_API_KEY, or
 * QUICKSTART_CLOUD=claude after `ant auth login`), escalations go to Claude. Without them, the
 * page asks you instead: you are the cloud, and the classifier learns from your answers.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..', '..');
const port = Number(process.env.PORT ?? 8787);
const useClaude = process.env.QUICKSTART_CLOUD === 'claude' || (!process.env.QUICKSTART_CLOUD && !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN));

// The cloud side: the same Claude runner the examples calibrate with (structured output, refusal
// fallback). It runs here, on the server, so the API key never reaches the page.
const cloud = useClaude ? (await import('../shared/cloud.mjs')).claudeCloud() : null;

const files = {
  '/': join(here, 'index.html'),
  '/belay-seed.json': join(root, 'examples', 'ticket-triage', 'belay-seed.json'),
};
const libs = { '/lib/core/': join(root, 'packages', 'core', 'dist'), '/lib/learn/': join(root, 'packages', 'learn', 'dist') };
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/api/belay' && req.method === 'POST') {
      if (!cloud) {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'no cloud configured' }));
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      // The request carries the task's instruction, JSON Schema and the (redacted) input.
      const output = await cloud.run(request, {});
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ value: output.value, usage: output.usage ?? null }));
    }
    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ cloud: cloud ? cloud.id : null }));
    }
    let file = files[url.pathname];
    for (const [prefix, dir] of Object.entries(libs)) {
      if (url.pathname.startsWith(prefix)) {
        const rel = normalize(url.pathname.slice(prefix.length));
        if (rel.startsWith('..') || !rel.endsWith('.js')) break;
        file = join(dir, rel);
      }
    }
    if (!file) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const content = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(content);
  } catch (err) {
    const missing = err.code === 'ENOENT' && String(err.path).includes(`${'dist'}`);
    res.writeHead(missing ? 500 : 502, { 'content-type': 'text/plain' });
    res.end(missing ? 'Build the packages first: npm run build (from the repository root)' : String(err.message ?? err));
  }
}).listen(port, () => {
  console.log(`Learned-classifier quickstart on http://localhost:${port}`);
  console.log(cloud ? `Escalations go to ${cloud.id}.` : 'No Anthropic credentials: you answer the escalations yourself (set ANTHROPIC_API_KEY to use Claude).');
});
