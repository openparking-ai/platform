import { createApp } from './app.js';
import { closePool } from './db.js';
import { assertSchemaCurrent } from './schema.js';
import { readAuthSettings } from './signIn.js';
import { assertValidationsDoor } from './validations.js';

const port = Number(process.env.PORT || 3000);

// Before the port opens, not after. A service that starts and then discovers it
// is behind has already served requests, and the requests it served are the
// silent ones: a rules payload one key short, read by the lane as unmeasured.
// The validations door is the same kind of claim: a setting that names a door
// this platform can never run would serve healthy while every garage offering
// validations charged its drivers the full fee.
try {
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

createApp().listen(port, () => console.log(`[platform] listening on :${port}`));
