import {test as base,expect} from '@playwright/test';
import path from 'node:path';
export * from '@playwright/test';
export const test=base.extend({
  page:async({page},provide,testInfo)=>{
    testInfo.annotations.push({type:'runtime',description:'production World V3 / Simulation V2; no legacy cookie'});
    const goto=page.goto.bind(page),screenshot=page.screenshot.bind(page);
    page.goto=async(...args)=>{const response=await goto(...args);if(args[0]!=='about:blank'){await expect(page.locator('.app-shell')).toHaveAttribute('data-world-schema-version','3',{timeout:90000});await expect(page.locator('.app-shell')).toHaveAttribute('data-simulation-schema-version','2');}return response;};
    page.screenshot=options=>options?.path?screenshot({...options,path:path.join(process.env.PAX_E2E_SCREENSHOT_DIR??'test-results/catalog-screenshots','v3',path.basename(options.path))}):screenshot(options);
    await provide(page);
    if(!page.isClosed()&&page.url()!=='about:blank'){await expect(page.locator('.app-shell')).toHaveAttribute('data-world-schema-version','3');await expect(page.locator('.app-shell')).toHaveAttribute('data-simulation-schema-version','2');}
  },
});
