// Entry point. Check the Node.js version before loading modules that rely on Node 22+ (global WebSocket).
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error([
    `tools/ui-shots には Node.js 22 以上が必要です（現在 v${process.versions.node}）。`,
    'Chrome の操作に Node.js 22 から標準で使える WebSocket を使うためです。',
    'Node.js 22 以上を入れてから、もう一度実行してください。',
  ].join('\n'));
  process.exit(2);
}
const { main } = await import('./main.mjs');
process.exitCode = await main(process.argv.slice(2));
// Safety net: never keep the terminal waiting on a stray handle after the report is written.
setTimeout(() => process.exit(process.exitCode), 5000).unref();
