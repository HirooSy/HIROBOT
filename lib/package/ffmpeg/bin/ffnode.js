#!/usr/bin/env node
import { main } from '../lib/cli.js';

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
