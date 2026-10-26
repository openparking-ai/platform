/**
 * A passkey authenticator in software, for the tests: it makes a P-256 key,
 * answers a creation with a "none" attestation, and signs an assertion with a
 * counter it keeps -- the bytes a browser would send, so the platform's real
 * verification (@simplewebauthn/server) runs on them unchanged.
 *
 * Every field a test may want wrong is an option: another origin, another
 * relying party, a counter that goes back, a signature over something else.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const sha256 = (data) => createHash('sha256').update(data).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export function fakeAuthenticator({ origin, rpId, counter = 0, step = 1 } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(32);
  const cose = Buffer.from(isoCBOR.encode(new Map([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ])));
  const self = {
    id: b64u(credentialId),
    counter,
    /** The public key as the accounts door hands it over: COSE, base64url. */
    publicKey: b64u(cose),

    /** A creation response for `options` (the `options` the platform sent). */
    register(options, { as = {} } = {}) {
      const clientData = Buffer.from(JSON.stringify({
        type: as.type ?? 'webauthn.create', challenge: as.challenge ?? options.challenge, origin: as.origin ?? origin, crossOrigin: false,
      }));
      const count = Buffer.alloc(4);
      count.writeUInt32BE(self.counter);
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        sha256(as.rpId ?? rpId ?? options.rp.id), Buffer.from([FLAG_UP | FLAG_UV | FLAG_AT]), count,
        Buffer.alloc(16), idLength, credentialId, cose,
      ]);
      const attestationObject = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return {
        id: self.id, rawId: self.id, type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestationObject), transports: ['internal'] },
      };
    },

    /** An assertion for `options`, the counter moved on by `step` first (0 keeps none). */
    signIn(options, { as = {}, counterTo } = {}) {
      if (counterTo !== undefined) self.counter = counterTo;
      else if (step > 0) self.counter += step;
      const clientData = Buffer.from(JSON.stringify({
        type: as.type ?? 'webauthn.get', challenge: as.challenge ?? options.challenge, origin: as.origin ?? origin, crossOrigin: false,
      }));
      const count = Buffer.alloc(4);
      count.writeUInt32BE(self.counter);
      const authData = Buffer.concat([sha256(as.rpId ?? rpId ?? options.rpId), Buffer.from([FLAG_UP | FLAG_UV]), count]);
      const signed = Buffer.concat([authData, sha256(clientData)]);
      const signature = sign('sha256', as.tamper ? Buffer.concat([signed, Buffer.from([0])]) : signed, privateKey);
      return {
        id: as.id ?? self.id, rawId: as.id ?? self.id, type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature) },
      };
    },
  };
  return self;
}
