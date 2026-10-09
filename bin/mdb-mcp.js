#!/usr/bin/env node
try {
  const { main } = await import('../dist/packages/mcp/index.js');
  await main();
} catch (error) {
  if (error.code === 'ERR_MODULE_NOT_FOUND') console.error('MDB is not built. Run npm run build in the Engram repository.');
  else console.error(error.message);
  process.exitCode = 1;
}
