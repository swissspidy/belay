#!/usr/bin/env node
import { main } from './cli.js';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`belay: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
