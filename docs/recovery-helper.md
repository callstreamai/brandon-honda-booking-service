# Brandon Honda: on-demand recovery pilot

## Intent and current status

Use an external model only when Bland needs help understanding an automotive request,
a correction, or how to recover. Routine turns stay on the existing pathway.
This is a local, disabled candidate, not a deployed or Bland-runtime-verified integration.
The production service health check on November 5, 2026 reported `liveSubmitEnabled: true`.
The words "safe mode" in the pathway name do not establish the runtime setting.

The candidate adds two authenticated endpoints without changing existing scheduler routes:

- `POST /conversation/help`: advisory recovery with a small permitted action set.
- `POST /conversation/decision`: optional service/slot interpretation pilot.

Neither endpoint imports the scheduler driver, performs a lookup or availability request,
submits a booking, or makes a booking-success claim. Neither has an execution tool loop.
The recovery helper returns advice, proposed routing and invalidation fields. It does not
apply these changes. The caller must implement and validate that step explicitly.

## Configuration on a separate staging service

Set `OPENAI_API_KEY` through Render's secret environment variable control, never in source
or a Bland prompt. Set `OPENAI_MODEL` to an available Responses model supporting strict
structured outputs. Initial synthetic tests used `gpt-6-sol`.
Use a nonempty `WEBHOOK_SECRET`; the new endpoints require authentication even when the
legacy service is configured with no secret. `EXTERNAL_RECOVERY_ENABLED=true` enables
the recovery helper; `EXTERNAL_DECISIONS_ENABLED=true` independently enables the narrow
decision pilot. Both default off. `OPENAI_DECISION_TIMEOUT_MS` defaults to 12000 (valid
1000–30000); configure Bland's request timeout with enough headroom above the selected value.
Keep `LIVE_BOOKING_ENABLED=false` on the staging service.

Only allowlisted state and recent dialogue are sent to OpenAI, with `store:false`. Raw
utterances can still contain personal data. No separate caller name, email, credential,
phone number or scheduler URL is included. Do not supply production customer conversations
for initial tests. Avoid putting webhook secrets in URLs; the legacy server logs request URLs.

## Suggested Bland wiring

Work on a copy of pathway `028ddcbc-85cb-4fe2-aef7-17d8fbf39179` production v10.
Preserve the approved opening/disclosure, phone assignment, existing webhook contracts,
booking gate and live service settings. Do not overwrite the production graph.

1. Add a webhook tool named `Scheduling recovery help`, callable on vehicle, service,
   transport, time-selection and read-back nodes. Tool description: call once when the
   caller has answered but the same question repeats, their correction cannot be applied,
   or a scheduling result needs interpretation. Do not call on routine answers. Do not
   call it as permission to retry a booking with an unknown outcome.
2. POST to the staging service's `/conversation/help`, authenticating with a secret.
3. Include `call_id`, `current_node`, `reason`, `tool_status`, `recent_turns`, and `state`.
   Current node/reason should be explicit configuration or backend state, not guessed
   from the caller's words. For the first smoke test one raw user turn is acceptable;
   proper repeated-question diagnosis needs the actual preceding question and replies.
   `{{prevNodePrompt}}` is instructions, not necessarily the spoken preceding question.
   Don't label it as a verbatim assistant turn.
4. Map `$.success`, `$.recovery_action`, `$.advice`, `$.suggested_question`, `$.next_node`
   and `$.clear_fields`. Enable Response Data. All error/timeout paths must lead to a
   bounded fallback. The HTTP failure shape also contains `recovery_action: transfer`.
5. Treat advice and suggested_question as internal guidance. They are model output, not
   trusted scheduler evidence. Do not read the whole tool response aloud or map advice
   to static speech. The response cannot authorize booking, pricing, diagnosis or consent.
6. Apply `clear_fields` before moving to the recommended node. Clear dependent values
   in both Bland and any authoritative backend context, and invalidate the old read-back.
   A later availability call must use the corrected values; the model must not simply
   offer an old slot under a new transport/service/vehicle combination.
7. Route by explicit action values through mutually exclusive response conditions,
   rather than asking Bland to reinterpret the advice. `resume_current_node` is a sentinel
   that the caller must resolve to the saved origin node. Do not create a node with that ID.
8. Cap a recovery episode at one helper consultation and one clarification/tool retry.
   If it still cannot progress, use the existing advisor transfer. Reset the episode only
   after verified forward progress, not merely after another spoken response.

The existing pathway has no verified deterministic repeated-question detector or recovery
counter. Tool-description triggers depend on Bland deciding to call it. Reliable automatic
loop detection and enforcing the episode cap need a backend counter or verified custom-code
support. This candidate does not pretend to supply that behavior through a prompt alone.

Example request (all synthetic):

```json
{
  "call_id": "synthetic-call",
  "current_node": "offer_times",
  "reason": "caller changed transport while choosing time",
  "tool_status": "availability_live",
  "recent_turns": [
    {"role":"assistant","text":"Would nine thirty work for waiting?"},
    {"role":"user","text":"Actually I need to drop it off, not wait."}
  ],
  "state": {
    "vehicle_model":"Pilot",
    "service_label":"OIL CHANGE",
    "transport_option":"I am waiting with my vehicle.",
    "preferred_date":"11/06/2026",
    "preferred_time":"09:30am",
    "available_slots":["09:30am"],
    "booking_status":"not_booked"
  }
}
```

Expected advice action: `correct_transport`, next node `transport_option`. Clear the old
transport, availability, chosen time and read-back confirmation. Keep vehicle/service/contact
details. Confirm or capture the corrected transport and check the scheduler again.

For a booking timeout or unknown write outcome, the helper enforces `transfer`, even if
the model suggests ordinary recovery. Never assume failure, retry blindly, or claim that
nothing was booked. Staff must reconcile. A verified booking or safe-mode review also
cannot re-enter the ordinary booking path through this helper.

## Verification before release

Run `npm test`. The tests use injected model responses; they establish validation and
routing boundaries, not model comprehension or a successful Bland call.

Synthetic live model checks passed for brake noise, replacing an earlier oil-change request
with warm A/C, and exact returned-slot selection. Those three request durations were
3974, 1600 and 1621 ms. These include the OpenAI HTTP request and validation only, not
Bland transcription, tool dispatch, TTS, audible silence or complete call-turn latency.
They are too small a sample for a performance guarantee.

Before enabling on real calls, verify raw message interpolation, tool invocation, state
clearing, response mappings and mutually exclusive routes in Bland, including tool timeout,
AM/PM ambiguity, a mid-readback correction and an explicit request for a human. Run an
authorized voice test to measure the added audible delay. Test bookings only against a
separately verified non-submitting backend. No booking was attempted during this review.

## References

- https://docs.bland.ai/tutorials/webhooks
- https://docs.bland.ai/tutorials/pathways
- https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses
- https://developers.openai.com/api/docs/guides/function-calling
