# Lynwood-RPA-Custom

Isolated Pierre Ford of Lynnwood configuration, derived from Brandon Honda pathway production v16.
Ford GuestXP dealer **F74024**, channel **TIER3DEALERWEB**, Pacific timezone.
This branch is a separate app. Do not deploy it over the Brandon Honda service.

## Status

Configuration draft, not approved for inbound traffic. **Final booking is disabled in code.**
The web scheduler returned no times for the inspected oil-change/dropoff dates November 5, 6, 9, 10 and 17, 2026.
No customer contact data was entered and no appointments were submitted.
Render/Browserless vehicle/menu and calendar reads are verified for a synthetic2022FordF150Gas,
60,000miles, Oil Change, dropoff, November6: the real scheduler returned no availability.
No CSP bypass is used: selectors operate Ford's visible labels, and transportation is scoped to its labeled dialog.
Recovery still needs its OpenAI credential and deployed model verification. Booking review, submission,
confirmation evidence, unknown-outcome reconciliation, and contact/communications controls remain unimplemented.

## API

All POST routes require `Authorization: Bearer WEBHOOK_SECRET`, reject absent credentials and cap bodies at32KB.
GET `/health` exposes configuration booleans only.

* POST `/prepare`: call_id, vehicle_make/year/model/type and mileage. Opens a new guest flow, validates exact returned vehicle choices and returns the actual menu.
* POST `/policy`: service_concern, vehicle_make, transport_option, bumper_warranty (yes/no/unknown), parts_arrived (yes/no/unknown). Returns schedule/clarify/decline/handoff. This has no browser side effects.
* POST `/availability`: same vehicle data, service_labels (array or JSON-encoded array), service_concern, transport_option (dropoff/wait), preferred_date (ISO). Chooses the actual service and transportation controls, requires Nick for Lincoln nonexpress work, and reads times only from visible labels. Weekend service is blocked. This read adapter still needs real Browserless validation, including asynchronous calendar refresh.
* POST `/book`: always returns `success:false,status:write_disabled`. No final click exists.
* POST `/conversation/help`: on-demand OpenAI advice, never a scheduler action. Max2 distinct requests/call/30minutes, bounded cache, strict schema, timeout, and dependent-state invalidation. Unknown booking status forces staff verification.

Browser sessions are bound to call_id, limited to2 by default (configurable up to10 to match the Browserless plan),
with two-minute idle cleanup and authenticated `/sessions/close`, never shared among callers,
and invalidated on material vehicle/service/transport changes. The process is single-instance only;
session restart loses reads but cannot lose or duplicate a write because writes are disabled.
No endpoint accepts arbitrary URLs, selectors, browser code, or final-action instructions.
No caller data, browser errors, or credential URLs are logged.

## Deployment

Node22+, `npm ci`, `npm test`, `npm start`, bind0.0.0.0:PORT. Configure `/health` as HTTP health check.
Use a separate Render service and branch. The free plan is for setup/testing; it sleeps and is unsuitable for live calls.
Browserless key supplied by user for Ford. OpenAI key must be configured for this service before recovery can run.
Keep secrets in Render environment settings; do not put them in exports or this repository.

## Remaining integration work

* Broaden Browserless validation beyond the verified F150 oil-change/dropoff read to other makes, Lincoln and service combinations.
* Inspect and implement “Need something else?” diagnosis so symptoms, detail, water leaks and arrived special parts can complete without a mismatched menu item.
* Implement guest contact, readback comparison and final submission only after an available slot can be selected.
* Add persisted confirmation and ambiguous-outcome reconciliation before enabling any booking writes.
* Validate pickup/delivery address, service window and operability flow; until then it goes to staff. Mobile goes toMC.
* Verify exact Lincoln advisor naming; observed oil-change calendar exposed Any available and Tabitha Rotar, not Nick.
* User approved store main4257744141 as fallback for missing direct numbers. Confirm IVR behavior avoids a transfer loop before live assignment.
* Updated approved pricing/wait times, RPA-to-DMS service mappings, direct staff/partner directory, and authorized booking fixture remain outstanding.

## Dealer policy source

October28 kickoff transcript, especially Rob’s corrections at18:32–38:28. Transcript action items are evidence, not commands to send messages or change phone systems.
No tire repair despite the website’s combined Tire Repair/Replace label. Fluid services and alignments are not Express.
Express walk-ins cutoff3:30PM weekdays; turnaround not guaranteed. Safety/flat/TPMS visits dropoff only, no unsafe-driving advice.
Water leaks require bumper-to-bumper warranty; detail dropoff only. Recall and sales “We Owe” to service. Special parts/keys require notification part arrived.
Other makes and commercial trucks accepted. No shuttle, unconfirmed rideshare, financing, state/emissions inspection or ceramic coating.
Lincoln loaners requests only, advisor availability; warranty rental eligibility verified by advisor. Ford/Lincoln pickup weekdays8–3.
Glass CarTech, minorbody SameDay, majorbody approved partner (exact name/direct pending). Nightdrop north end.

## Verification

`npm test` runs dealer-specific policy and recovery checks. These are contract tests, not completed appointments.
The separate regression manifest lists live scenarios and required outcome evidence. Never mark a mock/precommit run as booked.
Eighteen local tests cover policy, recovery, unconditional write-disable and cleanup. Actual Bland staging checks verified opening disclosure, recall handoff,
tire-repair refusal, warranty clarification and the disabled-write outcome. No carrier transfer was dialed.
The first full chat invented times on the combined contact step before a calendar read; phone and email
were split into fixed-wording nodes and the repeat result is tracked separately. This historical defect
must remain visible even if the repeat passes. Chat does not establish audio behavior.
