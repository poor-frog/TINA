import {waitForGuestNameInput} from './join';
import {googleGuestContinueSelectors,googleNameInputSelectors} from './selectors';
import {GoogleJoinRefusedError} from './refusal';

let passed=0,failed=0;
function check(name:string,ok:boolean) {
  if(ok){passed++;console.log(`PASS ${name}`);}
  else{failed++;console.error(`FAIL ${name}`);}
}
function fixture(stage='guest') {
  let current=stage,clicks=0;
  const page:any={url:()=> 'https://meet.google.com/abc-defg-hij',
    locator:(selector:string)=>({first:()=>({
      isVisible:async()=>current==='guest'?googleGuestContinueSelectors.includes(selector)
        :current==='name'?googleNameInputSelectors.includes(selector)
        :current==='refused'&&selector.includes("can't join"),
      elementHandle:async()=>({}),
    })}),waitForTimeout:async()=>{},
  };
  return {page,click:async()=>{clicks++;current='name';},get clicks(){return clicks;}};
}

(async()=>{
  const guest=fixture();
  const hit=await waitForGuestNameInput(guest.page,1000,guest.click);
  check('Continue as guest advances once to the name field',
    googleNameInputSelectors.includes(hit.selector)&&guest.clicks===1);

  const direct=fixture('name');
  await waitForGuestNameInput(direct.page,1000,direct.click);
  check('the existing name-field lobby skips guest continuation',direct.clicks===0);

  const refused=fixture('refused');
  const refusal=await waitForGuestNameInput(refused.page,1000,refused.click).catch(e=>e);
  check('a platform refusal is not clicked through',refusal instanceof GoogleJoinRefusedError&&refused.clicks===0);

  const slow=fixture();
  const expiry=await waitForGuestNameInput(slow.page,1,async()=>{
    await new Promise(resolve=>setTimeout(resolve,10));await slow.click();
  }).catch(e=>e);
  check('guest continuation shares the original deadline',
    expiry instanceof Error&&expiry.message.includes('exceeded the name-input budget')&&slow.clicks===1);
  console.log(`${passed} passed, ${failed} failed`);
  if(failed)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
