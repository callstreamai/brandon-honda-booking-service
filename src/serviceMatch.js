// Narrow aliases for explicitly named maintenance; unresolved symptoms never become unrelated work.
export function matchNamedServices(concern,menu){
 const exact=menu.filter(label=>String(concern||'').trim().toLowerCase()===label.toLowerCase());
 if(exact.length===1)return exact;
 let text=String(concern||'').toLowerCase();const found=[];
 const rules=[['The Works®',/\bthe works\b[®]?/g],['Oil Change',/\b(?:oil (?:and filter )?change|change (?:the )?oil)\b/g],['Tire Rotation',/\b(?:tire rotation|rotate (?:the |my )?tires)\b/g],['Battery',/\b(?:battery replacement|replace (?:the |my )?battery|new battery|battery service)\b/g],['Wheel Alignment',/\b(?:wheel alignment|alignment)\b/g],['Wipers',/\b(?:wiper replacement|replace (?:the |my )?wipers|new wipers)\b/g]];
 for(const[label,re]of rules){if(re.test(text)){if(!menu.includes(label))return [];found.push(label);re.lastIndex=0;text=text.replace(re,' ');}}
 if(found.includes('The Works®'))text=text.replace(/\bpackage\b|\boil service\b/g,' ');
 const remainder=text.replace(/\b(?:and|just|only|nothing|else|please|i|need|want|a|an|the|to|for|my|service|appointment|would|like)\b/g,'').replace(/[^a-z0-9]/g,'');
 return !remainder&&found.length?found:[];
}

// These are scheduler intake categories, not diagnoses or authorization to
// perform a repair. The complete customer concern is retained in booking notes.
export function closestServiceCategories(concern,menu){
 const text=String(concern||'').toLowerCase();
 const rules=[['The Works®',/\bthe works\b/],['Oil Change',/\boil\b/],['Tire Rotation',/rotat\w*.*tires?|tires?.*rotat/],['Battery',/\bbatter(?:y|ies)\b/],['Wheel Alignment',/\balign\w*/],['Wipers',/\bwipers?\b/],['Brakes',/\bbrak\w*/],['Cooling',/\bcoolant\b|cooling system/],['Filters',/\bfilters?\b/],['Lights',/\b(?:bulbs?|headlights?|taillights?)\b/],['Tire Repair/Replace',/flat tire|tire repair|tire replacement|new tires/]];
 let selected=rules.filter(([label,re])=>menu.includes(label)&&re.test(text)).map(([label])=>label);
 if(selected.includes('The Works®'))selected=selected.filter(label=>!['Oil Change','Tire Rotation'].includes(label));
 return selected;
}
