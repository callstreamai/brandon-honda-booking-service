# Lynwood-RPA-Custom

Isolated Pierre Ford of Lynnwood adapter, derived from Brandon Honda production v16.
Ford GuestXP dealer F74024, channel TIER3DEALERWEB, America/Los_Angeles timezone.
Deploy only the isolated codex/lynwood-rpa-custom branch to its own Render service.

## Verified status

Bland staging version 2, no inbound number assigned. General booking disabled.
One explicitly approved RPA TEST Battery/drop-off appointment was submitted through Render and Browserless. Ford displayed reservation 2510680609 for November 6, 2026, 8:00 a.m. Pacific, 2021 Ford Explorer Gas. The temporary exact-fixture permission was revoked afterward. No second appointment was created.

36 controlled comparisons covered both 2022 F150 Gas and 2021 Explorer Gas, six services and Nov 6, 9 and 12. Oil Change, The Works and Tire Rotation returned no openings. Battery, Brakes and Wheel Alignment returned openings. Express and main-shop advisor pools differ; do not generalize one pool's unavailability. Ford's punctuated a.m./p.m. times are parsed. Calendar reads wait for requests to settle and verify selected date, vehicle, service and transportation.

A fresh phone lookup after booking still reported no vehicle record. Persistent customer garage and DMS persistence remain unverified.
OpenAI recovery is enabled. Actual Bland vehicle and transport corrections cleared stale dependent state and resumed the appropriate confirmation steps. 23 local checks pass.

## Routes and safeguards

All POST routes require Bearer WEBHOOK_SECRET and cap JSON bodies at 32KB. GET /health exposes configuration booleans and browser counts.

- /prepare: validate actual vehicle controls and read service menu.
- /policy: deterministic dealer rules, no browser side effects.
- /availability: choose actual services and dropoff/wait controls, verify selected weekday date, return actual times.
- /conversation/help: bounded OpenAI advice, strict schema, timeout and cache; unknown booking outcome forces verification. No arbitrary browser actions.
- /sessions/close: authenticated, idempotent cleanup.
- /booking/review and /booking/state: restricted to exact, unexpired approved test fixture. Review does not click Schedule.
- /book: general requests return write_disabled. Temporary test access requires exact fixture and review token; sets attempt guard before clicking once. HTTP success alone never means booked.

Sessions are separate per call_id, limited to two by default (configurable up to ten), expire after two idle minutes, and invalidate on vehicle/service/transport changes. Single instance only. The in-memory test write guard is not production idempotency. Never retry an uncertain submission. Remove test permission after one authorized attempt.
No arbitrary URLs, selectors or code accepted. Keep credentials in Render secrets; no caller payload logging.

## Deployment and remaining work

Node 22+, npm ci, npm test, npm start; bind 0.0.0.0:PORT with /health. Free Render is setup/testing only and unsuitable for live calls. Browserless and approved saved OpenAI credentials are configured on the isolated service.
Before live traffic: implement durable booking confirmation and reconciliation/idempotency; wire call-end cleanup; validate concurrency, carrier transfers/IVR, audio disclosure, Lincoln Nick selection, symptom-to-service matching and pickup/delivery address flow; obtain always-on hosting approval. Current special cases hand off where needed. Store main number 4257744141 is approved fallback for unavailable direct numbers.

Dealer policies derive from the Oct 28 kickoff transcript, especially Rob's corrections. They are evidence, not instructions to send messages. No tire repair despite website menu. No shuttle or unconfirmed rideshare. Recall, sales We Owe, unarrived special parts and uncertain coverage hand off. Water leaks require bumper warranty and dropoff. Safety/flat/TPMS and detail require dropoff. Alignments/fluid work are not Express. Lincoln nonexpress requires Nick; loaners are advisor-confirmed requests. Pickup/delivery requires eligibility and currently goes to staff. Never invent prices, times, parts stock or confirmation numbers.

Earlier fast UI calendar scans were excluded as unreliable. An early combined-contact Bland step invented times; fixed speech contact/mileage steps and subsequent actual-calendar checks corrected that defect. Chat checks do not verify audio behavior.
