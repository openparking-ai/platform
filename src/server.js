import { createApp } from './app.js';
import { closePool } from './db.js';
import { assertSchemaCurrent } from './schema.js';

const port = Number(process.env.PORT || 3000);

// Before the port opens, not after. A service that starts and then discovers it
// is behind has already served requests, and the requests it served are the
// silent ones: a rules payload one key short, read by the lane as unmeasured.
try {
  await assertSchemaCurrent();
} catch (err) {
  console.error(`[platform] REFUSING TO SERVE: ${err.message}`);
  await closePool().catch(() => {});
  process.exit(1);
}

createApp().listen(port, () => console.log(`[platform] listening on :${port}`));
