/**
 * Generate a VAPID key pair for Web Push.
 *
 * Run once, then put the two values in the environment. The private key is a
 * signing key: it belongs in Vercel's environment variables and never in the
 * repository. The public key is handed to the browser, so it is not a secret —
 * but both must come from the same pair, and regenerating one silently
 * invalidates every existing subscription.
 *
 *   node scripts/gen-vapid.mjs
 */

import { generateKeyPairSync } from 'node:crypto';

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

const pub = publicKey.export({ format: 'jwk' });
const priv = privateKey.export({ format: 'jwk' });

// Web Push wants the public key as an uncompressed point: 0x04 ‖ X ‖ Y.
const point = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(pub.x, 'base64url'),
  Buffer.from(pub.y, 'base64url'),
]);

console.log('# Tambahkan ke .env (lokal) dan ke Environment Variables di Vercel.');
console.log('# JANGAN commit VAPID_PRIVATE_KEY.\n');
console.log(`VAPID_PUBLIC_KEY=${base64url(point)}`);
console.log(`VAPID_PRIVATE_KEY=${priv.d}`);
console.log('VAPID_SUBJECT=mailto:ganti@dengan-emailmu.com');
