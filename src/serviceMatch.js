// Narrow aliases for explicitly named maintenance; unresolved symptoms never become unrelated work.
export function matchNamedServices(concern,menu){
 let text=String(concern||'').toLowerCase();const found=[];
 const rules=[['The Works®',/\bthe works\b[®]?/g],['Oil Change',/\b(?:oil (?:and filter )?change|change (?:the )?oil)\b/g],['Tire Rotation',/\b(?:tire rotation|rotate (?:the |my )?tires)\b/g],['Battery',/\b(?:battery replacement|replace (?:the |my )?battery|new battery|battery service)\b/g],['Wheel Alignment',/\b(?:wheel alignment|alignment)\b/g],['Wipers',/\b(?:wiper replacement|replace (?:the |my )?wipers|new wipers)\b/g]];
 for(const[label,re]of rules){if(re.test(text)){if(!menu.includes(label))return [];found.push(label);re.lastIndex=0;text=text.replace(re,' ');}}
 const remainder=text.replace(/\b(?:and|just|only|nothing|else|please|i|need|want|a|an|the|to|for|my|service|appointment|would|like)\b/g,'').replace(/[^a-z0-9]/g,'');
 return !remainder&&found.length?found:[];
}
