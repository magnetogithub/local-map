import {buildDomainRootHash} from './domain-hash-root';
import {canonicalSerialize} from './canonical-serializer';import {sha256Hex} from './sha256';import type {WorldStateV3} from './world-state-v3';
const entityHashes=new WeakMap<object,string>(),states=new WeakMap<WorldStateV3,string>(),records=new WeakMap<object,string>();
const leaf=(entity:object)=>{let value=entityHashes.get(entity);if(!value){value=sha256Hex(canonicalSerialize({namespace:'world-v3-runtime-leaf.v1',entity}));entityHashes.set(entity,value);}return value;};
const root=(record:Readonly<Record<string,object>>,domain:'countries'|'territories')=>{let value=records.get(record);if(!value){value=buildDomainRootHash(domain,Object.fromEntries(Object.entries(record).map(([id,e])=>[id,leaf(e)])));records.set(record,value);}return value;};
/** Runtime domain roots hash changed mutable leaves; approved migration/offline hashes remain unchanged. */
export function worldV3RuntimeContentHash(world:WorldStateV3):string{
  let value=states.get(world);if(!value){value=sha256Hex(canonicalSerialize({namespace:'world-v3-runtime-content.v1',seedVersion:world.seedVersion,policyVersion:world.policyVersion,catalogRef:world.catalogRef,
    countries:root(world.countriesById,'countries'),territories:root(world.territoriesById,'territories'),retiredCountryIds:[...world.retiredCountryIds]}));states.set(world,value);}return value;
}
