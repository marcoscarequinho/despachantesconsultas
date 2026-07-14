// Zero-Config entry point for Vercel Functions.
//
// The legacy `builds` array in vercel.json silently ignores `maxDuration`
// (Vercel opts you out of Zero Config, which drops memory/timeout overrides —
// see https://github.com/vercel/vercel/discussions/5300). Zero Config only
// honors `maxDuration` for functions detected under /api, so this file just
// re-exports the existing Express app from server.js as that function.
module.exports = require('../server.js');
