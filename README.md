# Brandon Honda Booking Service

Bland-compatible HTTPS API for Brandon Honda service scheduling.

## Endpoints

- `GET /health`
- `POST /availability`
- `POST /book-service`

The initial deployment runs in `BOOKING_MODE=safe`, returning explicit simulated results. Set `BOOKING_MODE=live` only after the Reynolds portal driver is implemented and validated.

## Required environment variables

- `BOOKING_MODE`: `safe` or `live`; defaults to `safe`.
- `WEBHOOK_SECRET`: optional bearer token for Bland webhook/custom tool calls.

## Bland `/book-service` response shape

```json
{
  "success": true,
  "confirmation_number": "BH1234",
  "date": "09/05/2026",
  "time": "9:00 AM",
  "message": "...",
  "available_slots": [],
  "proof_url": null
}
```


## Live driver validation

The app includes a Browserless-backed `/portal-probe` endpoint that renders the Brandon Honda scheduling page and returns structured validation signals. In `BOOKING_MODE=live`, `/book-service` runs this probe and fails closed with `success: false` until final Reynolds submission is explicitly implemented and `ALLOW_LIVE_SUBMIT=true` is set.
