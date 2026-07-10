/* Runs every test suite; exits non-zero if any fails. Usage: node tests/run-all.js */
'use strict';
var cp = require('child_process');
var suites = ['scheduler.test.js', 'calendar.test.js', 'model.test.js', 'regressions.test.js', 'features.test.js', 'ops.test.js', 'server.test.js'];
var failed = 0;
suites.forEach(function (s) {
  var r = cp.spawnSync(process.execPath, [__dirname + '/' + s], { encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) failed++;
});
console.log(failed ? ('\n' + failed + ' suite(s) FAILED') : '\nAll suites passed.');
process.exit(failed ? 1 : 0);
