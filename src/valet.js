import crypto from 'node:crypto';
export const isValet=i=>i.transport_option==='pickup';
export const normalizeAddress=x=>String(x||'').toLowerCase().replace(/\b(united states|usa)\b/g,'').replace(/(\d{5})-\d{4}\b/g,'$1').replace(/\b(highway|hwy)\b/g,'hwy').replace(/\bstreet\b/g,'st').replace(/\bavenue\b/g,'ave').replace(/\broad\b/g,'rd').replace(/\bwashington\b/g,'wa').replace(/\bnorthwest\b/g,'nw').replace(/\bnortheast\b/g,'ne').replace(/\bsouthwest\b/g,'sw').replace(/\bsoutheast\b/g,'se').replace(/\bnorth\b/g,'n').replace(/\bsouth\b/g,'s').replace(/\beast\b/g,'e').replace(/\bwest\b/g,'w').replace(/[^a-z0-9]/g,'');
export const valetFingerprint=i=>crypto.createHash('sha256').update(JSON.stringify([normalizeAddress(i.pickup_address),i.pickup_access||'',i.vehicle_operable||''])).digest('hex');
export function spokenAddress(value){
 const words=['zero','one','two','three','four','five','six','seven','eight','nine'];
 return String(value||'').replace(/^\d+/,n=>n.split('').map(x=>words[Number(x)]).join(' ')+',').replace(/\b(\d{5})(?:-\d{4})?$/,n=>n.split('').map(x=>words[Number(x)]||x).join(' ')).replace(/\bAve\b/g,'Avenue').replace(/\bHwy\b/g,'Highway').replace(/\bWA\b/g,'Washington').replace(/\bW\b/g,'West').replace(/\bE\b/g,'East').replace(/\bN\b/g,'North').replace(/\bS\b/g,'South');
}
export function valetReview(i){const missing=valetMissing({...i,pickup_address_confirmed:true,pickup_confirmed_fingerprint:valetFingerprint(i)});if(missing)return {status:'details_required',missing_field:missing};return {status:'valet_review_ready',valet_review_fingerprint:valetFingerprint(i),pickup_address_confirmed:false,valet_summary:`For pickup, I have ${spokenAddress(i.pickup_address)}. Access and key instructions: ${i.pickup_access||'none'}. Are the address and instructions both correct?`};}
export function valetMissing(i){if(!/^\d+\s+.+\b\d{5}(?:-\d{4})?\s*$/.test(String(i.pickup_address||'').trim()))return 'pickup_address';if(![true,'true'].includes(i.pickup_address_confirmed)||i.pickup_confirmed_fingerprint!==valetFingerprint(i))return 'pickup_address_confirmed';if(!['yes','no'].includes(i.vehicle_operable))return 'vehicle_operable';if(String(i.pickup_access||'').length>125)return 'pickup_access';return null;}
export async function applyValetAddress(s,i){
 const p=s.page,missing=valetMissing(i);if(missing)return {success:false,status:'valet_details_required',missing_field:missing};
 await p.locator('#address-field-input').waitFor({state:'visible'});await p.locator('#address-field-input').fill(i.pickup_address);
 const options=p.getByRole('option');await options.first().waitFor({state:'visible'});
 const names=await options.allTextContents();const matches=names.filter(x=>normalizeAddress(x)===normalizeAddress(i.pickup_address));
 if(matches.length!==1)return {success:false,status:'pickup_address_unverified',message:'Pickup address could not be uniquely matched; do not substitute another address.'};
 await options.filter({hasText:matches[0]}).click();await p.locator('#find-vehicle-textarea').fill(i.pickup_access||'');
 s.pickupAddress=matches[0].trim();s.pickupAccess=i.pickup_access||'';
 await p.getByRole('button',{name:'Continue',exact:true}).first().click();await s.waitForReads();
 if(await p.locator('#address-field-input').isVisible())return {success:false,status:'pickup_address_unavailable',message:'Ford did not accept pickup availability for this address. Offer staff help; do not book drop-off instead.'};
 return null;
}
