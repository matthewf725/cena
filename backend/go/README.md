# Cena Go API

Minimal HTTP service that calls Supabase PostgREST using the public anon/publishable key and the caller's Supabase access token. It has no service-role credential and does not bypass RLS.

## Run

Requires Go 1.22+.

```sh
cd backend/go
SUPABASE_URL=https://YOUR_PROJECT.supabase.co SUPABASE_ANON_KEY=YOUR_PUBLIC_KEY go run ./cmd/cena-api
```

`PORT` defaults to `8080`. The service fails startup if either Supabase setting is absent. Browser CORS allows the exact origins `http://localhost:8081`, `http://localhost:8082`, `http://127.0.0.1:8081`, and `http://127.0.0.1:8082` by default. Override them with a comma-separated `CORS_ALLOWED_ORIGINS` list; setting the variable to an empty value uses the defaults. Preflight permits GET, POST, PATCH, OPTIONS and the Authorization and Content-Type headers. Upstream requests have an 8 second timeout and bounded response bodies; request bodies are capped at 64 KiB. `/healthz` is a liveness response and does not depend on Supabase availability.

## Routes

- `GET /healthz` returns `{"status":"ok"}`.
- `GET /v1/catalog` returns `{restaurants,items,slots,inventory}` from fixed, read-only PostgREST queries. Supabase RLS limits every read; caller query params are ignored.
- `POST /v1/orders` forwards the request to `create_order`. JSON body uses RPC argument names: `p_restaurant_id`, `p_slot_id`, `p_idempotency_key`, `p_pickup_mode` (`counter` or `curbside`), optional `p_vehicle`, and `p_items` (`[{"item_id":"UUID","quantity":1}]`).
- `PATCH /v1/orders/{id}/status` body: `{"status":"accepted"}`. Calls `update_order_status` and leaves membership and transition rules to the database.
- `POST /v1/analytics/events` body: `{"event_type":"menu_view","restaurant_id":"UUID or null","payload":{}}`. Calls `track_event`; consent and supported event validation remain in SQL.

All writes require `Authorization: Bearer <Supabase access token>`. The JWT is forwarded verbatim to PostgREST with the anon/publishable key so database `auth.uid()` and RLS remain in force. Never configure a service-role key here. Errors from upstream are intentionally mapped to generic HTTP errors to avoid exposing database details.

Run unit tests with `go test ./...`.
