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
 if([true,'true'].includes(input.fuel_defaulted))notes.push('Gas is being used because the fuel type is not known.');
 notes.push(`Scheduler service: ${services.join(', ')}. Your original service concerns are included in the appointment notes for the advisor.`);
 return notes.join(' ');
}
export function appointmentNotes(input,selected,services){
 const actual=[input.vehicle_year,input.vehicle_make,input.vehicle_model].join(' ');
 const concern=String(input.service_concern||'').replace(/\b(?:i (?:just )?(?:need|want)(?: to get)?|i have|my|please|also|and|that's|that is|are|is|an|a)\b/gi,' ').replace(/\s+/g,' ').trim();
 const notes=`Actual ${actual}; ${concern}`+([true,'true'].includes(input.fuel_defaulted)?'; fuel unknown, Gas default':'');
 return notes;
}
