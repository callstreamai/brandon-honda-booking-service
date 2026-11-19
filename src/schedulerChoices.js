const normalized=x=>String(x||'').toLowerCase().replace(/[^a-z0-9]/g,'');
export function nearestYears(requested,options){
 return options.filter(x=>/^\d{4}$/.test(x)&&Math.abs(Number(x)-Number(requested))<=5&&Number(x)!==Number(requested)).sort((a,b)=>Math.abs(Number(a)-Number(requested))-Math.abs(Number(b)-Number(requested))||Number(b)-Number(a));
}
export function equivalentModel(requested,options){
 const exact=options.filter(x=>normalized(x)===normalized(requested));
 if(exact.length===1)return exact[0];
 const base=normalized(requested).replace(/ford|lincoln/g,'');
 const family=options.filter(x=>normalized(x).replace(/ford|lincoln/g,'')===base);
 return family.length===1?family[0]:null;
}
export function selectionNote(input,selected,services){
 const requested=[input.vehicle_year,input.vehicle_make,input.vehicle_model].join(' ');
 const actual=[selected.year,selected.make,selected.model].join(' ');
 const notes=[];
 if(normalized(requested)!==normalized(actual))notes.push(`The scheduler uses ${actual} as the closest vehicle entry; your actual ${requested} is recorded in the notes.`);
 if([true,'true'].includes(input.fuel_defaulted))notes.push(`${selected.type||'Gas'} is being used because the fuel type is not known.`);
 notes.push(`I will reserve the ${services.join(' and ')} appointment type and include your original concerns for the advisor.`);
 return notes.join(' ');
}
export function readbackFields(input,date){
 const day=new Date(date+'T12:00:00Z').getUTCDate();
 const suffix=day>=11&&day<=13?'th':({1:'st',2:'nd',3:'rd'}[day%10]||'th');
 const month=new Date(date+'T12:00:00Z').toLocaleDateString('en-US',{month:'long',timeZone:'UTC'});
 const digits=String(input.caller_phone||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');
 return {booking_customer_name:input.customer_account_type==='business'?input.business_name:input.customer_name,
 appointment_date_spoken:month+' '+day+suffix,
 transport_readback:input.transport_option==='pickup'?`pickup and delivery at ${input.pickup_address}. Vehicle and keys: ${input.pickup_access}`:input.transport_option==='wait'?'waiting at the dealership':'dropping the vehicle off',
 contact_readback:`Your callback number is ${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}.`};
}
export function appointmentNotes(input,selected,services){
 const actual=[input.vehicle_year,input.vehicle_make,input.vehicle_model].join(' ');
 const concern=String(input.service_concern||'').replace(/\b(?:i (?:just )?(?:need|want)(?: to get)?|i have|my|please|also|and|that's|that is|are|is|an|a)\b/gi,' ').replace(/\s+/g,' ').trim();
 const notes=`Actual ${actual}; ${concern}`+([true,'true'].includes(input.fuel_defaulted)?`; fuel unknown, ${selected.type||'Gas'} default`:'');
 return notes;
}
