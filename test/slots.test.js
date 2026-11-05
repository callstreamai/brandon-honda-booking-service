import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTimeLabel} from '../src/slots.js';
test('Ford punctuated meridiems are actual slots and retain their exact label',()=>{
 assert.deepEqual(parseTimeLabel('3:30 p.m.'),{text:'3:30 p.m.',minutes:930});
 assert.equal(parseTimeLabel('7:30 a.m.').minutes,450);
 assert.equal(parseTimeLabel('12:00 p.m.').minutes,720);
 assert.equal(parseTimeLabel('12:00am').minutes,0);
});
test('date labels and invalid clock values cannot become offered times',()=>{
 for(const text of ['FRI 6 NOV','No service times available','13:30 p.m.','0:00 a.m.','11:90am'])assert.equal(parseTimeLabel(text),null);
});
