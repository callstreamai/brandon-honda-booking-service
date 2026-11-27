import {valetMissing} from './valet.js';
export const dealer = Object.freeze({
  name: 'Pierre Ford of Lynnwood', code: 'F74024', timezone: 'America/Los_Angeles',
  scheduler: 'https://www.guestxpui.ford.com/?channelType=TIER3DEALERWEB&dealerCode=F74024',
  address: '20020 Highway 99, Lynnwood, WA 98036', mainPhone: '4257744141',
  serviceHours: 'Monday through Friday, 7:30 AM to 6 PM; closed weekends',
  pickupHours: 'Monday through Friday, 8 AM to 3 PM',
  nightDrop: 'north end of the building', towing: {name:'R&R Star', phone:'4257789557'}
});

export function normalizeTransport(value) {
  const t=String(value||'').trim().toLowerCase();
  if (/^(pickup|pick[ -]?up(?: and delivery)?|pickup\/delivery|valet|delivery)$/.test(t)) return 'pickup';
  if (/^(drop[ -]?off|leave it with you|drop the vehicle off)$/.test(t)) return 'dropoff';
  if (/^(wait|waiting|waiter)$/.test(t)) return 'wait';
  return t;
}
export function policyDecision(input) {
  const text = `${input.service_concern || ''} ${input.service_free_text || ''} ${input.initial_request || ''}`.toLowerCase();
  const transport = normalizeTransport(input.transport_option);
  if(Number(input.contact_contract_version)>=3&&transport==='pickup')return {action:'handoff',target:'service',reason:'Service arranges all pickup, delivery and valet requests.'};
  if (/recall/.test(text)) return {action:'handoff', target:'service', reason:'Collect the known recall description; service must verify remedy and parts.'};
  if (/\bwe[ -]?owe\b|sales promised/.test(text)) return {action:'handoff', target:'sales', reason:'We Owes go to Sales.'};
  if (/mobile service/.test(text+' '+transport)) return {action:'handoff', target:'mc', reason:'Mobile service is arranged by MC.'};
  if (/\bglass\b|windshield/.test(text)) return {action:'handoff', target:'cartech', reason:'Glass work is referred to CarTech Auto Glass.'};
  if (/scratch|\bdent\b|minor body/.test(text)) return {action:'handoff', target:'same_day', reason:'Minor body work goes to Same Day Auto Scratch and Dent Repair.'};
  if (/collision|major body|body repair/.test(text)) return {action:'handoff', target:'body_shop', reason:'Major body repair goes to Stack Auto Rebuild, 19230 Hwy 99, Lynnwood, 425-775-1112.'};
  if (/emissions|state inspection|auto.?butler|paint sealant|ceramic coat/.test(text)) return {action:'decline', reason:'This service is not offered.'};
  if (/water leak/.test(text)) {
    if (input.bumper_warranty === 'unknown' || !input.bumper_warranty) return {action:'clarify', field:'bumper_warranty', reason:'Water leaks require bumper-to-bumper warranty coverage.'};
    if (input.bumper_warranty !== 'yes') return {action:'handoff', target:'service', reason:'Water leaks without bumper-to-bumper coverage need Service.'};
  }
  if (/special.?order|new key|replacement key/.test(text)) {
    if (!input.parts_arrived || input.parts_arrived === 'unknown') return {action:'clarify', field:'parts_arrived', reason:'Ask whether parts or service notified the caller the part is in.'};
    if (input.parts_arrived !== 'yes') return {action:'handoff', target:'service', reason:'Service must verify the part arrived before scheduling.'};
  }
  if (/shuttle|uber|lyft|rideshare|rental/.test(transport)) return {action:'clarify', field:'transport_option', reason:'No shuttle, rideshare or rental is offered; offer waiting or drop-off when eligible.'};
  const dropOnly = /detail|check engine|heater diagnos|\bflat\b|(?:tire|tyre|low).*pressure|\btpms\b|inoperable|safety/.test(text);
  if (dropOnly && transport !== 'dropoff' && !(transport==='pickup'&&/check engine|heater diagnos/.test(text)&&!/detail|inoperable|safety|flat|pressure/.test(text))) return {action:'clarify', field:'transport_option', reason:'This request requires drop-off; do not promise waiting or safe driving.'};
  if (/pickup|delivery/.test(transport)) {
    if (!/^(ford|lincoln)$/i.test(input.vehicle_make || '')) return {action:'clarify', field:'transport_option', reason:'Pickup and delivery is approved for Ford and Lincoln only.'};
    if(input.vehicle_operable==='no')return {action:'handoff',target:'service',reason:'Pickup/delivery requires a safe, operable vehicle; arrange appropriate roadside help.'};
    const missing=valetMissing(input);if(missing)return {action:'clarify',field:missing,reason:'Pickup/delivery requires a confirmed full street/city/state/ZIP address and safe, operable vehicle. Access instructions must fit 125 characters.'};
    if(input.vehicle_operable!=='yes')return {action:'handoff',target:'service',reason:'Pickup/delivery requires a safe, operable vehicle; arrange appropriate roadside help.'};
  }
  const diagnostic = /fluid|align|warranty|check engine|repair|diagnos|noise|squeak|grind|vibrat|knock|leak|transmission|overheat|stall|won.t start|no start|brake (?:job|replace|service)|replace.*brake/.test(text);
  const express = /oil change|rotation|filter|wiper|bulb|battery|brake inspection|the works/.test(text) && !diagnostic;
  return {action:'schedule', advisor: /^lincoln$/i.test(input.vehicle_make || '') ? 'Nick' : 'any', dropOnly, express};
}

export function inputFingerprint(input) {
  return JSON.stringify(['customer_account_type','business_name','vehicle_make','vehicle_year','vehicle_model','vehicle_type','vehicle_mileage','service_labels','service_concern','transport_option','bumper_warranty','parts_arrived','pickup_address','pickup_address_confirmed','pickup_confirmed_fingerprint','pickup_access','vehicle_operable'].map(k=>input[k] ?? null));
}

export function isServiceDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(date+'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === date && ![0,6].includes(d.getUTCDay());
}
