export function parseTimeLabel(value){
  const text=String(value||'').trim();
  const m=text.match(/^(\d{1,2}):([0-5]\d)\s*([ap])\.?m\.?$/i);
  if(!m||Number(m[1])<1||Number(m[1])>12)return null;
  return {text,minutes:(Number(m[1])%12)*60+Number(m[2])+(m[3].toLowerCase()==='p'?720:0)};
}
