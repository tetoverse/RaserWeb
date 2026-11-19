const dns = require('dns');
const net = require('net');

/**
 * Parse an IPv4 address string into an array of 4 octets, or null if invalid.
 */
function parseIpv4(ip) {
  if (net.isIPv4(ip) === false) return null;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts;
}

/**
 * Check if an IPv4 address (4 octets) is a globally routable public address.
 */
function isPublicIpv4Octets([a, b, c]) {
  if (a === 0) return false;                              // 0.0.0.0/8 (unspecified)
  if (a === 10) return false;                             // 10.0.0.0/8 (private)
  if (a === 100 && b >= 64 && b <= 127) return false;     // 100.64.0.0/10 (CGNAT)
  if (a === 127) return false;                            // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return false;               // 169.254.0.0/16 (link-local / metadata)
  if (a === 172 && b >= 16 && b <= 31) return false;      // 172.16.0.0/12 (private)
  if (a === 192 && b === 0 && c === 0) return false;      // 192.0.0.0/24 (IETF protocol)
  if (a === 192 && b === 0 && c === 2) return false;      // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return false;               // 192.168.0.0/16 (private)
  if (a === 198 && (b === 18 || b === 19)) return false;  // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51 && c === 100) return false;   // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return false;    // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return false;                             // 224.0.0.0/4 (multicast) & 240.0.0.0/4 (reserved)
  return true;
}

/**
 * Parse an IPv6 address string into 8 16-bit groups, or null if invalid.
 */
function parseIpv6(ip) {
  if (ip.includes('%')) return null; // Reject zone indices (link-local/scoped)
  if (!net.isIPv6(ip)) return null;

  let addr = ip.toLowerCase();
  // Handle embedded IPv4 at the end (e.g. ::ffff:127.0.0.1)
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = parseIpv4(tail);
    if (!octets) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    addr = addr.slice(0, lastColon + 1) + hi + ':' + lo;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 0) return null;

  const groups = [
    ...left.map(g => parseInt(g, 16)),
    ...Array(Math.max(0, missing)).fill(0),
    ...right.map(g => parseInt(g, 16))
  ];
  if (groups.length !== 8 || groups.some(g => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

/**
 * Check if an IPv4 or IPv6 address string is a globally routable public IP.
 * Rejects loopback, private, link-local, multicast, reserved, and IPv4-mapped IPv6.
 */
function isPublicIp(ip) {
  if (typeof ip !== 'string' || !ip) return false;
  const trimmed = ip.trim().replace(/^\[|\]$/g, '');
  const version = net.isIP(trimmed);
  if (version === 4) {
    const octets = parseIpv4(trimmed);
    return octets ? isPublicIpv4Octets(octets) : false;
  }
  if (version === 6) {
    const g = parseIpv6(trimmed);
    if (!g) return false;

    // ::/128 (unspecified) and ::1/128 (loopback)
    const isAllZeroPrefix = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
    if (isAllZeroPrefix && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return false;

    // ::ffff:0:0/96 (IPv4-mapped IPv6) and ::/96 (IPv4-compatible)
    if (isAllZeroPrefix && (g[5] === 0 || g[5] === 0xffff)) return false;
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) return false;

    // 64:ff9b::/96 (NAT64)
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return false;

    // 100::/64 (discard-only)
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false;

    // 2001:db8::/32 (documentation)
    if (g[0] === 0x2001 && g[1] === 0x0db8) return false;

    // fc00::/7 (unique local / private)
    if ((g[0] & 0xfe00) === 0xfc00) return false;

    // fe80::/10 (link-local) and fec0::/10 (site-local)
    if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return false;

    // ff00::/8 (multicast)
    if ((g[0] & 0xff00) === 0xff00) return false;

    return true;
  }
  return false;
}

/**
 * Create a custom net/dns lookup function pinned to a pre-validated IP address.
 */
function createPinnedLookup(pinnedAddress, pinnedFamily) {
  return (hostname, opts, cb) => {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    if (opts && opts.all) {
      return cb(null, [{ address: pinnedAddress, family: pinnedFamily }]);
    }
    return cb(null, pinnedAddress, pinnedFamily);
  };
}

/**
 * Validate a target URL against SSRF rules, resolve DNS, verify all returned IPs
 * are public, and return a pinned address + lookup function for the connection.
 */
async function validateAndPinUrl(rawUrl, options = {}) {
  const lookupFn = options.dnsLookup || ((host, opts) => dns.promises.lookup(host, opts));

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    const err = new Error('Invalid url');
    err.statusCode = 400;
    throw err;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const err = new Error('Unsupported protocol');
    err.statusCode = 400;
    throw err;
  }

  const hostname = (parsed.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    const err = new Error('Blocked target');
    err.statusCode = 403;
    throw err;
  }

  const ipVersion = net.isIP(hostname);
  if (ipVersion !== 0) {
    if (!isPublicIp(hostname)) {
      const err = new Error('Blocked target');
      err.statusCode = 403;
      throw err;
    }
    return {
      parsed,
      pinnedAddress: hostname,
      pinnedFamily: ipVersion,
      lookup: createPinnedLookup(hostname, ipVersion)
    };
  }

  let records;
  try {
    records = await lookupFn(hostname, { all: true });
  } catch (_) {
    const err = new Error('DNS resolution failed');
    err.statusCode = 502;
    throw err;
  }

  if (!Array.isArray(records) || records.length === 0) {
    const err = new Error('DNS resolution failed');
    err.statusCode = 502;
    throw err;
  }

  for (const rec of records) {
    if (!rec || !isPublicIp(rec.address)) {
      const err = new Error('Blocked target');
      err.statusCode = 403;
      throw err;
    }
  }

  const preferred = records.find(r => r.family === 4) || records[0];
  return {
    parsed,
    pinnedAddress: preferred.address,
    pinnedFamily: preferred.family || net.isIP(preferred.address),
    lookup: createPinnedLookup(preferred.address, preferred.family || net.isIP(preferred.address))
  };
}

module.exports = {
  isPublicIp,
  createPinnedLookup,
  validateAndPinUrl
};
