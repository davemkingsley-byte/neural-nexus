/*
 * auth.js — identity + role resolution for the ProjectDesk server. Stdlib only.
 *
 * Two classes of request:
 *   LOCAL  — no Cloudflare tunnel markers. The mini itself (browser, CLI,
 *            launchd health checks). Trusted: role "editor", email "local".
 *   REMOTE — arrived through the Cloudflare Tunnel (cf-* headers present).
 *            Must carry a valid Cloudflare Access JWT (Cf-Access-Jwt-Assertion),
 *            which we verify OURSELVES against the team's public keys (JWKS):
 *            RS256 signature, issuer, audience, expiry. Defense in depth — even
 *            if the Access policy at the edge is misconfigured or removed, this
 *            server never trusts an unauthenticated remote request.
 *
 * FAIL CLOSED: remote requests are rejected 503 until auth.json is configured.
 *
 * auth.json (next to server.js; gitignored — copy auth.example.json):
 *   {
 *     "cloudflareAccess": {
 *       "teamDomain": "https://<team>.cloudflareaccess.com",
 *       "aud": "<application audience tag from the Access app>"
 *     },
 *     "editors": ["davemkingsley@gmail.com"],
 *     "viewers": "any-authenticated"        // or an explicit email array
 *   }
 */
'use strict';

var fs = require('fs');
var path = require('path');
var https = require('https');
var crypto = require('crypto');

var JWKS_TTL_MS = 10 * 60 * 1000;
var CLOCK_SKEW_S = 60;

function loadConfig(rootDir) {
  var file = process.env.PROJECTDESK_AUTH_CONFIG || path.join(rootDir, 'auth.json');
  try {
    var cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cfg && cfg.cloudflareAccess && cfg.cloudflareAccess.teamDomain && cfg.cloudflareAccess.aud) {
      cfg.cloudflareAccess.teamDomain = String(cfg.cloudflareAccess.teamDomain).replace(/\/+$/, '');
      cfg.editors = (cfg.editors || []).map(function (e) { return String(e).toLowerCase(); });
      if (Array.isArray(cfg.viewers)) cfg.viewers = cfg.viewers.map(function (e) { return String(e).toLowerCase(); });
      return cfg;
    }
  } catch (e) { /* absent or invalid -> unconfigured */ }
  return null;
}

// A request that came through the Cloudflare tunnel carries cf-* headers.
// (A local prankster curl -H'cf-ray: x' only downgrades itself to the stricter
// remote path, so spoofing these locally gains nothing.)
function isTunnelRequest(req) {
  return !!(req.headers['cf-access-jwt-assertion'] || req.headers['cf-ray'] ||
    req.headers['cf-connecting-ip'] || req.headers['cf-access-authenticated-user-email']);
}

// ---- JWKS cache -------------------------------------------------------------
var jwksCache = { keys: null, fetchedAt: 0, teamDomain: null };

function fetchJwks(teamDomain, cb) {
  var now = Date.now();
  if (jwksCache.keys && jwksCache.teamDomain === teamDomain && (now - jwksCache.fetchedAt) < JWKS_TTL_MS) {
    return cb(null, jwksCache.keys);
  }
  var url = teamDomain + '/cdn-cgi/access/certs';
  // Guard the callback so a timeout + late response/error can't invoke it twice
  // (which would double-send an HTTP response and crash the single process).
  var settled = false;
  function done(err, keys) { if (settled) return; settled = true; cb(err, keys); }
  var req = https.get(url, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      try {
        var body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || !Array.isArray(body.keys)) return done(new Error('bad JWKS response'));
        jwksCache = { keys: body.keys, fetchedAt: Date.now(), teamDomain: teamDomain };
        done(null, body.keys);
      } catch (e) { done(e); }
    });
  });
  req.on('error', function (e) { done(e); });
  req.setTimeout(5000, function () { req.destroy(new Error('JWKS fetch timeout')); done(new Error('JWKS fetch timeout')); });
}

function b64urlToBuf(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

// Signature check against one public key. Returns Error or null.
function checkSignature(parts, pub) {
  try {
    return crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]),
      pub, b64urlToBuf(parts[2])) ? null : new Error('bad signature');
  } catch (e) { return new Error('signature check failed: ' + e.message); }
}

// Claim validation shared by production and test paths. Returns Error or null.
function checkClaims(payload, cfg) {
  var now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now - CLOCK_SKEW_S) return new Error('token expired');
  if (typeof payload.nbf === 'number' && payload.nbf > now + CLOCK_SKEW_S) return new Error('token not yet valid');
  if (payload.iss !== cfg.cloudflareAccess.teamDomain) return new Error('wrong issuer');
  var aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (aud.indexOf(cfg.cloudflareAccess.aud) < 0) return new Error('wrong audience');
  if (!payload.email) return new Error('no email claim');
  return null;
}

// Verify a Cloudflare Access JWT. cb(err, payload)
function verifyAccessJwt(token, cfg, cb) {
  var parts = String(token).split('.');
  if (parts.length !== 3) return cb(new Error('malformed token'));
  var header, payload;
  try {
    header = JSON.parse(b64urlToBuf(parts[0]).toString('utf8'));
    payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
  } catch (e) { return cb(new Error('malformed token json')); }
  if (header.alg !== 'RS256') return cb(new Error('unexpected alg ' + header.alg));

  function finish(sigErr) {
    if (sigErr) return cb(sigErr);
    var claimErr = checkClaims(payload, cfg);
    if (claimErr) return cb(claimErr);
    cb(null, payload);
  }

  // Test hook: a PEM public key injected via config bypasses the JWKS fetch
  // (used by the test suite with a locally-generated keypair; never set in
  // production).
  if (cfg.testPublicKeyPem) {
    var pub;
    try { pub = crypto.createPublicKey(cfg.testPublicKeyPem); } catch (e) { return cb(e); }
    return finish(checkSignature(parts, pub));
  }

  function verifyWithKeys(keys, retried) {
    var jwk = keys.filter(function (k) { return k.kid === header.kid; })[0];
    if (!jwk) {
      // Key rotation: refetch once on unknown kid.
      if (!retried) {
        jwksCache.fetchedAt = 0;
        return fetchJwks(cfg.cloudflareAccess.teamDomain, function (err, fresh) {
          if (err) return cb(err);
          verifyWithKeys(fresh, true);
        });
      }
      return cb(new Error('no matching signing key'));
    }
    var pub;
    try { pub = crypto.createPublicKey({ key: jwk, format: 'jwk' }); }
    catch (e) { return cb(new Error('bad JWK: ' + e.message)); }
    finish(checkSignature(parts, pub));
  }

  fetchJwks(cfg.cloudflareAccess.teamDomain, function (err, keys) {
    if (err) return cb(err);
    verifyWithKeys(keys, false);
  });
}

function roleFor(email, cfg) {
  email = String(email).toLowerCase();
  if (cfg.editors && cfg.editors.indexOf(email) >= 0) return 'editor';
  if (Array.isArray(cfg.viewers)) return cfg.viewers.indexOf(email) >= 0 ? 'viewer' : null;
  return 'viewer'; // "any-authenticated"
}

/*
 * Resolve the identity of a request. cb(identity) where identity is:
 *   { ok: true,  email, role: 'editor'|'viewer', remote: bool }
 *   { ok: false, status, error }
 */
function identify(req, cfg, cb) {
  if (!isTunnelRequest(req)) {
    return cb({ ok: true, email: 'local', role: 'editor', remote: false });
  }
  if (!cfg) {
    return cb({ ok: false, status: 503, error: 'remote access is not configured on this server (auth.json missing)' });
  }
  var token = req.headers['cf-access-jwt-assertion'];
  if (!token) {
    return cb({ ok: false, status: 401, error: 'not authenticated (no Access token)' });
  }
  verifyAccessJwt(token, cfg, function (err, payload) {
    if (err) return cb({ ok: false, status: 401, error: 'authentication failed: ' + err.message });
    var role = roleFor(payload.email, cfg);
    if (!role) return cb({ ok: false, status: 403, error: 'account not authorized for this planner' });
    cb({ ok: true, email: String(payload.email).toLowerCase(), role: role, remote: true });
  });
}

module.exports = {
  loadConfig: loadConfig,
  identify: identify,
  verifyAccessJwt: verifyAccessJwt,
  isTunnelRequest: isTunnelRequest,
  roleFor: roleFor
};
