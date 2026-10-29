#!/usr/bin/env node
import { main } from '../src/cli.mjs';

try {
  const status = await main();
  if (typeof status === 'number') process.exitCode = status;
} catch (error) {
  process.stderr.write(`Computer Use：${error.message}\n`);
  process.exitCode = 1;
}
