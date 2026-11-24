// GuestXP's observed manual diagnostic intake. No chatbot message is sent.
export const diagnosisLabel='General Diagnosis';
export const normalizeConcern=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export function concernMatches(expected,actual){
 const wanted=normalizeConcern(expected);
 return !!wanted&&wanted===normalizeConcern(actual);
}
export async function manualConcernAvailable(page){
 return await page.getByRole('button',{name:'Toggle general diagnosis options',exact:true}).count()===1;
}
export async function selectManualConcern(s,input){
 const p=s.page,concern=String(input.service_concern||'').trim();
 if(!concern||concern.length>750)return {success:false,status:'service_details_required',message:'The diagnostic description must contain the customer concern and fit the scheduler’s 750-character limit. No text was truncated.'};
 s.stage='manual_concern';
 await p.getByRole('button',{name:'Toggle general diagnosis options',exact:true}).click();
 const unsure=p.getByRole('radio',{name:'I am not sure',exact:true});
 await unsure.locator('xpath=ancestor::label[1]').click();
 if(!await unsure.isChecked())throw new Error('Manual diagnosis was not selected');
 await p.getByRole('button',{name:'Help Summarize My Issue',exact:true}).click();
 s.stage='manual_concern_bypass';
 await p.getByRole('button',{name:'Describe It Myself',exact:true}).click();
 const dialog=p.getByRole('dialog');
 const summary=p.getByRole('textbox',{name:'Vehicle Concern Summary*',exact:true});
 const exitHeading=dialog.getByRole('heading',{name:'Exit AI Assistant?',exact:true});
 // Accept either the manual form or Ford's exit confirmation.
 await summary.or(exitHeading).first().waitFor();
 if(await exitHeading.isVisible())await dialog.getByRole('button',{name:'Yes',exact:true}).click();
 s.stage='manual_concern_entry';
 await summary.fill(concern);
 if(!concernMatches(concern,await summary.inputValue()))throw new Error('Manual concern did not preserve the customer description');
 await p.getByRole('button',{name:'Save',exact:true}).click();
 s.stage='manual_concern_saved';
 await s.waitForReads();
 if(await p.getByRole('button',{name:'Save',exact:true}).isEnabled())throw new Error('Manual concern save did not complete');
 const saved=await summary.inputValue();
 if(!concernMatches(concern,saved))throw new Error('Saved manual concern differs from the customer description');
 if(!await p.getByRole('button',{name:'Continue',exact:true}).isEnabled())throw new Error('Manual diagnosis did not enable continuation');
 s.manualConcern=saved;
 return null;
}

export async function verifyManualConcernReview(s,input){
 if(!concernMatches(input.service_concern,s.manualConcern))return false;
 const p=s.page;
 await p.getByRole('button',{name:'General Diagnostics',exact:true}).click();
 try{
  const saved=p.getByText(s.manualConcern,{exact:true});
  await saved.waitFor({state:'visible'});
  if(!concernMatches(input.service_concern,await saved.innerText()))return false;
  s.verifiedManualConcern=s.manualConcern;
  return true;
 }finally{await p.getByRole('button',{name:'close popover window',exact:true}).click();}
}
