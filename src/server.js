import { createApp } from './app.js';
import { closePool } from './db.js';
import { assertSchemaCurrent } from './schema.js';
import { dummyHash } from './passwords.js';
import { readAuthSettings } from './signIn.js';
import { assertCanSend, readEmailSettings } from './email.js';
import { assertStartSettings } from './startSettings.js';
import { assertValidationsDoor } from './validations.js';

// Before the port opens, not after. A service that starts and then discovers it
// is behind has already served requests, and the requests it served are the
// silent ones: a rules payload one key short, read by the lane as unmeasured.
// The validations door is the same kind of claim: a setting that names a door
// this platform can never run would serve healthy while every garage offering
// validations charged its drivers the full fee.
//
// The number settings first: a pool size that is not one would leave the
// schema check below waiting on a pool that can never hand out a connection.
let port;
try {
  ({ PORT: port } = assertStartSettings());
  assertValidationsDoor();
  await assertSchemaCurrent();
} catch (err) {
  console.error(`[platform] REFUSING TO SERVE: ${err.message}`);
  await closePool().catch(() => {});
  process.exit(1);
}

// The sign-in settings are read before the port opens too: a value that is
// not one of their forms refuses to start, and the two that weaken or switch
// off owner sign-in are said out loud.
let auth;
try {
  auth = readAuthSettings();
} catch (err) {
  console.error(`[platform] REFUSING TO SERVE: ${err.message}`);
  await closePool().catch(() => {});
  process.exit(1);
}
if (!auth.cookieSecure) {
  console.error(
    '[platform] WARNING: SESSION_COOKIE_INSECURE=true -- the sign-in cookie is sent WITHOUT Secure, ' +
      'over plain http. For local development only; never on a deployment anyone reaches.',
  );
}
if (auth.adminOrigin === null) {
  console.log('[platform] owner sign-in is off: ADMIN_ORIGIN is not set');
}

// Email (0032) the same way: a setting that is not one of its forms refuses to
// start, and so does a key file that is named and cannot be read -- found now,
// not when the first owner asks for a reset. With none, it is said once.
try {
  const email = readEmailSettings();
  if (email.configured) assertCanSend(email);
  else console.log('[platform] email is off: EMAIL_KEY_FILE and EMAIL_FROM are not set, so no reset link is sent');
  if (email.configured && !email.noticeTo) console.log('[platform] no one is told when an invite is accepted: EMAIL_NOTICE_TO is not set');
} catch (err) {
  console.error(`[platform] REFUSING TO SERVE: ${err.message}`);
  await closePool().catch(() => {});
  process.exit(1);
}

if (typeof auth.trustProxy === 'number') {
  console.log(
    `[platform] TRUST_PROXY=${auth.trustProxy}: the caller's address is read ${auth.trustProxy} hop(s) from the right ` +
      'of X-Forwarded-For. This must equal the real number of proxies in front of this server: larger, and a ' +
      "caller's forged X-Forwarded-For chooses the address the sign-in lock and limit count.",
  );
}

const app = createApp();

// The decoy hash an unknown email is checked against is FINISHED before the
// port opens. Started but unfinished, the first unknown email after a start
// waits for it and then hashes again -- two hashes to a known email's one,
// a difference the refusal floor does not cover at its lower values.
try {
  await dummyHash();
} catch (err) {
  console.error(`[platform] REFUSING TO SERVE: the sign-in decoy hash could not be made (${err.code ?? err.name})`);
  await closePool().catch(() => {});
  process.exit(1);
}

app.listen(port, () => console.log(`[platform] listening on :${port}`));
