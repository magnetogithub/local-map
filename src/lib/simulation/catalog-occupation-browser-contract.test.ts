import {describe,it,expect} from 'vitest';import fs from 'node:fs';
import {parseSimulationContextV1} from './simulation-context';import {validateResolutionAgainstContext} from './server/context-resolution-validator';
import {createTurnResolutionFunctionParametersSchema} from './turn-resolution';
describe('occupation production browser contract',()=>{
  it('keeps host lifecycle fields out of model submit schema',()=>{
    const schema=JSON.stringify(createTurnResolutionFunctionParametersSchema());expect(schema).not.toMatch(/authorityLifecycle|referenceLifecycle/);expect(schema).toContain('territory.occupy');expect(schema).toContain('countries.merged');
  });
  it.skipIf(!process.env.PROMPT14_OCCUPATION_EVIDENCE)('validates all captured actual production requests/responses against the server contract',()=>{
    const evidence=JSON.parse(fs.readFileSync(process.env.PROMPT14_OCCUPATION_EVIDENCE!,'utf8'));expect(evidence.status).toBe('pass');expect(evidence.turns).toHaveLength(6);
    for(const turn of evidence.turns){const context=parseSimulationContextV1(turn.context),validation=validateResolutionAgainstContext(turn.resolution,context);expect(validation.ok,JSON.stringify({stage:turn.stage,issues:validation.issues})).toBe(turn.expectedValidation);}
    expect(evidence.phases.find((p:{phase:string})=>p.phase==='invalid-tail-atomic-rollback').calls).toEqual([]);
    for(const phase of evidence.phases.filter((p:{territories?:unknown})=>p.territories)){expect(phase.wholeSourceSetDataCalls).toBe(0);expect(phase.fullProjectionBuilds).toBe(1);}
  });
});
