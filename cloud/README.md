# General POS cloud control service

This Atlas-facing service is separate from the local POS server, so local sales remain available when the cloud is unavailable.

Add the following root `.env` values before starting it: `MONGODB_URI`, `CLOUD_JWT_SECRET`, `CLOUD_ADMIN_KEY`, and optionally `CLOUD_PORT=4100`.

Run `npm run cloud:start`.

Endpoints: `POST /admin/devices` creates one device and a time-limited activation code; `POST /devices/activate` exchanges it for a signed device lease; `GET /devices/me/policy` refreshes device policy; and `POST /sync/events` accepts bounded idempotent event batches. The local POS enrollment screen and SQLite outbox are the next implementation stage.
