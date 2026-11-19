// Interpret explicit synonyms only. Ambiguous/negated replies remain unresolved.
export const canonicalChoices={vehicle_type:['Gas','Hybrid','Diesel','Electric'],customer_account_type:['individual','business'],transport_option:['dropoff','wait','pickup'],confirmation_method:['Text','Email','Both','None','Phone']};
const aliases={
 vehicle_type:{gas:'Gas',gasoline:'Gas',petrol:'Gas','gasoline only':'Gas','gas only':'Gas',hybrid:'Hybrid','plug in hybrid':'Hybrid',phev:'Hybrid',diesel:'Diesel',electric:'Electric','fully electric':'Electric','all electric':'Electric',bev:'Electric'},
 customer_account_type:{individual:'individual',personal:'individual',private:'individual','my own':'individual',business:'business',fleet:'business','business/fleet':'business',commercial:'business'},
 transport_option:{dropoff:'dropoff','drop off':'dropoff','leave it with you':'dropoff','drop the vehicle off':'dropoff',wait:'wait',waiting:'wait',waiter:'wait','wait there':'wait','stay there':'wait',pickup:'pickup','pick up':'pickup','pickup and delivery':'pickup','pick up and delivery':'pickup',valet:'pickup'},
 confirmation_method:{text:'Text',sms:'Text',email:'Email',both:'Both','text and email':'Both',none:'None',neither:'None',phone:'Phone'}
};
export function canonicalValue(field,value){const key=String(value??'').trim().toLowerCase().replace(/[-_]/g,' ').replace(/[.!]$/,'').replace(/\s+/g,' ');return aliases[field]?.[key]??null;}
export function normalizeResponseState(state){const out={...state};for(const field of Object.keys(aliases)){const value=canonicalValue(field,state?.[field]);if(value)out[field]=value;}return out;}

// Opt-in scheduling policy approved by the client: an explicitly unknown fuel
// answer uses Gas. Missing answers and explicit corrections remain distinct.
export function completionDefaults(state){
 const out=normalizeResponseState(state);
 if(![true,'true'].includes(out.completion_fallbacks))return out;
 const unknown=/^(unknown|not sure|unsure|i (?:do not|don't|dont) know|don't know|dont know)$/i.test(String(out.vehicle_type||'').trim());
 if(unknown){out.vehicle_type='Gas';out.fuel_defaulted=true;}
 else if(out.vehicle_type&&out.vehicle_type!=='Gas')out.fuel_defaulted=false;
 const digits=v=>String(v||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');
 if(!/^\d{10}$/.test(digits(out.caller_phone))&&/^\d{10}$/.test(digits(out.caller_id)))out.caller_phone=digits(out.caller_id);
 return out;
}
