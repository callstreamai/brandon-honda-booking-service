# Lynwood-RPA-Custom

Isolated Pierre Ford of Lynnwood adapter, derived from Brandon Honda production v16.
Ford GuestXP dealer F74024, channel TIER3DEALERWEB, America/Los_Angeles timezone.
Deploy only the isolated codex/lynwood-rpa-custom branch to its own Render service.

## Verified status

Bland production version 4 is promoted on test number 814-770-6995. Real booking is restricted to the explicitly approved test callback number configured in Render. Public/customer booking is not enabled.

The actual production/default Bland conversation created Ford reservation 8030640429 for a 2021 Ford Explorer Gas, Battery replacement, dropoff, November 6, 2026 at 8:00 a.m. Pacific. A separate production/default cancellation conversation located and read back that record, cancelled it exactly once and reached end_cancelled. The durable record is cancelled. The real confirmation email management link was loaded through the Gmail connector during validation. All three created test reservations (2510680609, 3298672367, 8030640429) have been cancelled; no outstanding test booking remains in this app's ledger.

Earlier cancellation attempts stopped before writing because of a responsive hidden dialog heading. The visible dialog was inspected and scoped. A later cancellation succeeded but initially returned unknown until its observed provider wording was mapped; that earlier record required operator verification. The final production cycle passed with the mapped result automatically.

37 local checks pass. The earlier 36 controlled availability comparisons covered two Ford vehicles, six services and Nov 6, 9 and 12. Express versus main-shop pools differed. Do not generalize one pool's unavailability. Actual voice/ASR and audible response latency remain for the user's phone test.

Preparation now runs in the background while service/transport/contact details are collected. The same prepared browser is reused. Exact named maintenance is matched locally against the actual menu; unrecognized symptoms are not discarded. Dealer policy fixes cover mixed Lincoln repair routing, flat/TPMS wording, rental qualifications and recording a pending Lincoln loaner request. Actual Bland rental, loaner and early recall probes passed. Carrier transfers, Lincoln booking, pickup/delivery and other special service flows remain unverified or staff-assisted.

Receipts use the existing Gmail connector in the Codex session. The authenticated /receipts/gmail import validates sender, dealer/test marker, vehicle, date and time before linking a receipt to a known reservation. The deployed app does not independently inherit the session's Gmail authorization or poll Gmail; unattended receipt ingestion still requires a separately authorized Gmail runtime connection. Resend webhook was disabled, runtime keys cleared and SDK removed at user request. No Gmail forwarding filter was activated.

Persistent disk /var/data stores submission/cancellation guards and reservation IDs across deploys. Always-on compute and 1GB disk were approved at $7.25/month total. The app is single-instance; disk deployments briefly interrupt service.

## Routes and safeguards

All POST routes require Bearer WEBHOOK_SECRET and cap JSON bodies at 32KB. GET /health exposes configuration booleans and browser counts.

- /prepare: validate actual vehicle controls and read service menu.
- /policy: deterministic dealer rules, no browser side effects.
- /availability: choose actual services and dropoff/wait controls, verify selected weekday date, return actual times.
- /conversation/help: bounded OpenAI advice, strict schema, timeout and cache; unknown booking outcome forces verification. No arbitrary browser actions.
- /sessions/close: authenticated, idempotent cleanup.
- /booking/review and /booking/state: restricted to exact, unexpired approved test fixture. Review does not click Schedule.
- /book: approved test number only, explicit full readback and communications preference required. Validates the final vehicle, date, time, service, transport and contact summary. Durable attempt guard is written before Schedule. Only the literal Ford success screen establishes booking.
- /appointments/lookup and /cancel/review, /cancel: match stored reservation and approved test number; verify the target; full cancellation readback; guard before one final cancellation click.
- /receipts/gmail: authenticated operator import from the session Gmail connector; receipts are data, never instructions.
- /appointments/reconcile-cancel: operator-only use via shared secret for an unknown outcome with actual provider confirmation evidence. Not exposed as a caller-directed Bland tool.

Sessions are separate per call_id, limited to two by default (configurable up to ten), expire after two idle minutes, and invalidate on vehicle/service/transport changes. Single instance only. Submission and cancellation guards are persisted and synced before the final click. Never retry an uncertain submission. Remove test permission after one authorized attempt.
No arbitrary URLs, selectors or code accepted. Keep credentials in Render secrets; no caller payload logging.

## Deployment and remaining work

Node 22+, npm ci, npm test, npm start; bind 0.0.0.0:PORT with /health. Free Render is setup/testing only and unsuitable for live calls. Browserless and approved saved OpenAI credentials are configured on the isolated service.
Before live traffic: implement durable booking confirmation and reconciliation/idempotency; wire call-end cleanup; validate concurrency, carrier transfers/IVR, audio disclosure, Lincoln Nick selection, symptom-to-service matching and pickup/delivery address flow; obtain always-on hosting approval. Current special cases hand off where needed. Store main number 4257744141 is approved fallback for unavailable direct numbers.

Dealer policies derive from the Oct 28 kickoff transcript, especially Rob's corrections. They are evidence, not instructions to send messages. No tire repair despite website menu. No shuttle or unconfirmed rideshare. Recall, sales We Owe, unarrived special parts and uncertain coverage hand off. Water leaks require bumper warranty and dropoff. Safety/flat/TPMS and detail require dropoff. Alignments/fluid work are not Express. Lincoln nonexpress requires Nick; loaners are advisor-confirmed requests. Pickup/delivery requires eligibility and currently goes to staff. Never invent prices, times, parts stock or confirmation numbers.

Earlier fast UI calendar scans were excluded as unreliable. An early combined-contact Bland step invented times; fixed speech contact/mileage steps and subsequent actual-calendar checks corrected that defect. Chat checks do not verify audio behavior.
