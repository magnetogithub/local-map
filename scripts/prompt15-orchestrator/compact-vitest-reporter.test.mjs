import {test,expect,vi} from 'vitest';
import Reporter from './compact-vitest-reporter.mjs';

test('module collection failures remain visible when no test case could start',()=>{
  const output=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
  try{
    new Reporter().onTestRunEnd([{moduleId:'candidate.test.ts',errors:()=>[{message:'EACCES during import'}],children:{allSuites:()=>[],allTests:()=>[]}}],[],'failed');
    const result=JSON.parse(output.mock.calls[0][0]);expect(result.pass).toBe(false);expect(result.counts).toMatchObject({total:0,errors:1});expect(result.failures).toEqual([{name:'candidate.test.ts',message:'EACCES during import'}]);
  }finally{output.mockRestore();}
});

test('a suite setup error cannot be hidden by passing child assertions',()=>{
  const output=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
  try{
    new Reporter().onTestRunEnd([{moduleId:'candidate.test.ts',errors:()=>[],children:{allSuites:()=>[{fullName:'nested suite',errors:()=>[{message:'setup failed'}]}],allTests:()=>[{fullName:'actual assertion',result:()=>({state:'passed',errors:[]})}]}}],[],'failed');
    const result=JSON.parse(output.mock.calls[0][0]);expect(result.pass).toBe(false);expect(result.counts).toMatchObject({total:1,passed:1,errors:1});expect(result.failures[0].name).toBe('nested suite');
  }finally{output.mockRestore();}
});

test('criterion coverage remains complete after hundreds of matching assertions',()=>{
  const output=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
  try{
    const tests=Array.from({length:150},(_,i)=>({fullName:`15-02:acceptance witness ${i}`,result:()=>({state:'passed',errors:[]})}));
    tests.push({fullName:'15-02:preservation final negative witness',result:()=>({state:'passed',errors:[]})});
    new Reporter().onTestRunEnd([{moduleId:'actual.test.ts',errors:()=>[],children:{allSuites:()=>[],allTests:()=>tests}}],[],'passed');
    const result=JSON.parse(output.mock.calls[0][0]);expect(result.pass).toBe(true);expect(result.counts.passed).toBe(151);expect(result.cases).toEqual([{name:'15-02:acceptance',state:'passed'},{name:'15-02:preservation',state:'passed'}]);
  }finally{output.mockRestore();}
});
