import fs from 'node:fs';
const edit=(p,f)=>{const before=fs.readFileSync(p,'utf8'),after=f(before);if(after===before)throw Error(`No region edit: ${p}`);fs.writeFileSync(p,after);};
edit('src/lib/simulation/world-effect.ts',s=>s.replace('const effectBase =','const effectBase =')
  .replaceAll('territoryIds:z.array(authorityTerritoryIdSchema).min(1).max(MAX_AUTHORITY_TERRITORIES).refine(ids=>ids.every((id,i)=>i===0||ids[i-1]<id))','territoryIds:z.array(authorityTerritoryIdSchema).max(MAX_AUTHORITY_TERRITORIES).refine(ids=>ids.every((id,i)=>i===0||ids[i-1]<id)),regionRefs:z.array(z.strictObject({countryId:countryIdSchema,reference:subdivisionReferenceSchema})).min(1).max(8).optional()'));
edit('src/lib/simulation/simulation-context.ts',s=>s
  .replace('  subdivisions: readonly Readonly<{','  regionCatalog?: import("../world/world-geometry-catalog-ref").WorldGeometryCatalogRef;\n  subdivisions: readonly Readonly<{')
  .replace('  subdivisions: z.array(z.strictObject({','  regionCatalog: z.strictObject({catalogVersion:z.string().max(160),geometryRoot:z.string().regex(/^[a-f0-9]{64}$/),topologyRoot:z.string().regex(/^[a-f0-9]{64}$/),renderArtifactRoot:z.string().regex(/^[a-f0-9]{64}$/),manifestPath:z.string().max(256)}).optional(),\n  subdivisions: z.array(z.strictObject({')
  .replace('    subdivisions: Object.freeze(subdivisions),','    ...(world.schemaVersion===3?{regionCatalog:world.catalogRef}:{}),\n    subdivisions: Object.freeze(subdivisions),'));
edit('src/lib/simulation/catalog-turn-plan.ts',s=>`import {resolveCatalogRegionEffects,type CatalogRegionIndex} from './catalog-region';\nimport {parseTurnResolutionV1} from './turn-resolution';\n${s}`
  .replace('catalog:WorldGeometryCatalogContract}', 'catalog:WorldGeometryCatalogContract;regionIndex?:CatalogRegionIndex}')
  .replace('validateTurnResolution(input.resolution,input.simulation','validateTurnResolution(resolveCatalogRegionEffects(parseTurnResolutionV1(input.resolution),input.regionIndex),input.simulation')
  .replace('      const {effectId,causedByEventId,type,...payload}=effect;void causedByEventId;\n      const aggregate=', '      const {effectId,causedByEventId,type,regionRefs,...payload}=effect;void causedByEventId;void regionRefs;\n      const aggregate='));
edit('src/lib/simulation/server/context-resolution-validator.ts',s=>`import {resolveCatalogRegionEffects,type CatalogRegionIndex} from '../catalog-region';\n${s}`
  .replace('  debugWorldEffectActionIds?:','  regionIndex?: CatalogRegionIndex;\n  debugWorldEffectActionIds?:')
  .replace('parseTurnResolutionV1(raw), context.countryMapColors','resolveCatalogRegionEffects(parseTurnResolutionV1(raw),options.regionIndex), context.countryMapColors')
  .replaceAll('if(!territoryOwners.has(id))add(', 'if(!territoryOwners.has(id)&&!options.regionIndex?.hasTerritory(id))add('));
edit('src/lib/simulation/server/openai-responses-provider.ts',s=>`import {loadCatalogRegionIndex} from '../catalog-region.server';\n${s}`
  .replace('    const tools = createSimulationToolManifest();','    const regionIndex=request.context.regionCatalog?loadCatalogRegionIndex():undefined;\n    if(regionIndex&&regionIndex.records[0]?.ref.catalogId!==request.context.regionCatalog?.catalogVersion)throw Error("REGION_CATALOG_MISMATCH");\n    const tools = createSimulationToolManifest();')
  .replace('{debugWorldEffectActionIds});','{debugWorldEffectActionIds,regionIndex});')
  .replace('args, request.context);','args, request.context,regionIndex);'));
