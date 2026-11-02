import {afterEach, describe, expect, it, vi} from 'vitest';
import {createWorldV3SyntheticFixture} from '../test-only/world-v3-synthetic-fixture';
import {migrateWorldStateV2ToV3} from '../test-only/world-v2-to-v3-migration';
import {createInitialSimulationState} from '../simulation/initial-simulation-state';
import {createSimulationStateV2, migrateSimulationStateV1ToV2} from '../simulation/simulation-state-v2';
import {validateCountryChangeMapColorCommand} from './country-change-map-color';
import {planCountryMapColors} from '../planning/country-map-color-planner';

function fixture() {
  const f = createWorldV3SyntheticFixture();
  const world = migrateWorldStateV2ToV3({legacyWorld:f.legacy, catalog:f.catalog, mapping:f.mapping,
    countryMapColors:f.countryMapColors, validateCanonicalCoverage:f.validateCanonicalCoverage});
  const event = {eventId:'event.color',date:'2020-01-01',title:'Color mandate',publicNarrative:'A mandate was issued.',
    actorCountryIds:['AAA'],relatedFactIds:[],relatedSituationIds:[],causes:[],outcomeCategory:'domestic',significance:'notable'};
  const empty = migrateSimulationStateV1ToV2(createInitialSimulationState(f.legacy,'AAA'),world);
  const authority = {id:'cpa:color',actorCountryId:'AAA',targetCountryId:'AAA',allowedMapColors:['#CC0000','#FFFFFF'],
    validFrom:'2020-01-01',validTo:'2020-01-31',sourceEventId:event.eventId};
  const simulation = createSimulationStateV2({...empty,eventLog:[event],countryPresentationAuthoritiesById:{[authority.id]:authority},countryPresentationAuthorityOrder:[authority.id]},world);
  const command = {commandId:'command.color',type:'country.changeMapColor',expectedRevision:world.revision,
    payload:{actorCountryId:'AAA',countryId:'AAA',mapColor:'#CC0000',authorityId:authority.id}};
  return {world, simulation, empty, command};
}
afterEach(() => vi.unstubAllEnvs());
describe('14-15 bounded color command', () => {
  it('accepts canonical requested color under matching active authority', () => {
    const f = fixture();expect(validateCountryChangeMapColorCommand(f.command,f.world,f.simulation)).toEqual(f.command);
  });
  it('rejects stale revision, wrong actor/target/color, unknown/retired country and invalid schema', () => {
    const f = fixture();
    for (const command of [{...f.command,expectedRevision:0}, ...[
      {actorCountryId:'BBB'}, {countryId:'BBB'}, {countryId:'ZZZ'}, {mapColor:'#000000'},
      {mapColor:'#cc0000'}, {authorityId:'cpa:unknown'}, {geometry:{}},
    ].map(p => ({...f.command,payload:{...f.command.payload,...p}}))]) {
      expect(() => validateCountryChangeMapColorCommand(command,f.world,f.simulation)).toThrow();
    }
    for (const date of ['2019-12-31','2020-02-01']) expect(() => validateCountryChangeMapColorCommand(f.command,f.world,f.simulation,{date})).toThrow();
  });
  it('debug cannot waive canonical values, active IDs or stale revisions, and is disabled in production', () => {
    const f = fixture();vi.stubEnv('NODE_ENV','development');
    expect(validateCountryChangeMapColorCommand(f.command,f.world,f.empty,{debugDirective:true})).toEqual(f.command);
    expect(() => validateCountryChangeMapColorCommand({...f.command,expectedRevision:0},f.world,f.empty,{debugDirective:true})).toThrow();
    expect(() => validateCountryChangeMapColorCommand(f.command,f.world,f.empty,{debugDirective:true,date:'invalid'})).toThrow();
    vi.stubEnv('NODE_ENV','production');
    expect(() => validateCountryChangeMapColorCommand(f.command,f.world,f.empty,{debugDirective:true})).toThrow(/AUTHORITY/);
  });
  it('plans one country delta while preserving initiator identity and limiting affected territories', () => {
    const f = fixture(), before = f.world.countriesById.AAA;
    const plan = planCountryMapColors({...f,commands:[f.command]});
    expect(plan.commandCount).toBe(1);expect(plan.changedCountryIds).toEqual(['AAA']);
    expect(plan.countries.AAA).toEqual({...before,mapColor:'#CC0000'});
    expect(plan.affectedTerritoryIds).toEqual(f.world.territoryOrder.filter(id=>f.world.territoriesById[id].ownerCountryId==='AAA'));
    expect(f.world.countriesById.AAA).toBe(before);
    expect(() => planCountryMapColors({...f,commands:[f.command,{...f.command,commandId:'bad',payload:{...f.command.payload,authorityId:'cpa:unknown'}}]})).toThrow();
    expect(f.world.countriesById.AAA).toBe(before);
  });
});
