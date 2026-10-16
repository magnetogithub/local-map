// Vitest 4 public Reporter API. Complete results, not console text, decide PASS.
export default class CompactVitestReporter {
  onTestRunEnd(modules, errors, reason) {
    const counts = {passed: 0, failed: 0, skipped: 0, pending: 0, total: 0, errors: errors.length};
    const failures = [],caseStates=new Map();
    const addFailure = (name, error) => {
      if (failures.length < 40) failures.push({name: String(name).slice(0, 512), message: String(error?.message ?? error).slice(0, 2048)});
    };
    for (const testModule of modules) {
      for (const suite of [testModule,...testModule.children.allSuites()]) for (const error of suite.errors()) {
        counts.errors++;addFailure(suite.fullName??testModule.moduleId,error);
      }
      for (const test of testModule.children.allTests()) {
      const result = test.result(); counts.total++;
      for(const [id]of String(test.fullName??'').matchAll(/15-\d{2}:(?:acceptance|preservation)/g)){
        if(caseStates.get(id)!=='passed')caseStates.set(id,result.state);
      }
      counts[Object.hasOwn(counts, result.state) ? result.state : 'pending']++;
      for (const error of result.errors ?? []) addFailure(test.fullName, error);
      }
    }
    for (const error of errors) addFailure('unhandled', error);
    const pass = reason === 'passed' && counts.total > 0 && counts.passed === counts.total && !counts.errors;
    process.stdout.write(`${JSON.stringify({version: 1, complete: true, reason, pass, counts,
      files: modules.map(testModule => testModule.moduleId), failures,cases:[...caseStates].map(([name,state])=>({name,state}))})}\n`);
  }
}
