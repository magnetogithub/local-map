import {test as base} from '@playwright/test';
import path from 'node:path';
export * from '@playwright/test';
/** Existing geometry/source contracts run against the isolated historical fixture.
 * New catalog E2E imports Playwright directly and receives the V3 production route. */
export const test=base.extend({
  context:async({context,baseURL},provide)=>{
    await context.addCookies([{name:'pax-legacy-regression',value:'1',url:baseURL??'http://127.0.0.1:3000'}]);
    await provide(context);
  },
  page:async({page},provide,testInfo)=>{
    testInfo.annotations.push({type:'runtime',description:'historical World V2 geometry/source regression only; excluded from V3 evidence'});
    const capture=page.screenshot.bind(page);
    const originalRoot=path.resolve('screenshots');
    const outputRoot=path.resolve(process.env.PAX_E2E_SCREENSHOT_DIR??'test-results/legacy-screenshots');
    page.screenshot=options=>{
      if(!options?.path)return capture(options);
      const relative=path.relative(originalRoot,path.resolve(options.path));
      if(relative.startsWith('..')||path.isAbsolute(relative))return capture(options);
      return capture({...options,path:path.join(outputRoot,relative)});
    };
    await provide(page);
  },
});
