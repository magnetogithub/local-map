import fs from 'node:fs';
import path from 'node:path';
import geojsonVt from 'geojson-vt';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {DELIVERY_POLICY} from './prompt14-source-gate.mjs';
import {CATALOG_POLICY, canonical, compareText, digest, hashCanonical, jsonBytes, writeArtifact} from './prompt14-catalog-core.mjs';
import {buildCatalogTopology, territoryIdForAtom} from './prompt14-catalog-topology.mjs';

export const rootBytes=(domain,bytes)=>digest(Buffer.concat([Buffer.from(`${domain}\0`),bytes]));
export const RENDER_POLICY=Object.freeze({
  ...DELIVERY_POLICY,tileOptions:{...DELIVERY_POLICY.tileOptions,promoteId:null},
  idTransport:'Stable positive integer feature.id in PBF; canonical string territoryId/edgeId properties promoted per layer by MapLibre.',
  publicFiles:'Small manifest, tile byte index and vector tiles only. Full geometry and topology are build-only.',
});
export function makeCatalogEntries(atoms,inputs) {
  const provenanceById={},entries=[];
  const add=p=>{const id=`provenance:${hashCanonical('catalog-provenance-id.v1',p)}`;provenanceById[id]=p;return id;};
  for(const atom of atoms){
    const p=atom.identity,provenance=[{sourceId:'canonical-country-p0-2020',sourceVersion:p.sourceVersion,sourceFeatureId:`P0:${p.sourceCountryId}`,boundaryKind:'project-game-seed-derived-2020',operationalOnly:false}];
    if(p.inputRole==='P1')provenance.push({sourceId:'natural-earth-admin1-states-provinces-10m',sourceVersion:p.sourceVersion,sourceFeatureId:p.sourceFeatureId,boundaryKind:'administrative-operational',operationalOnly:true});
    else if(p.inputRole==='P0-source-component')for(const sourceFeatureId of inputs.selected.features[atom.members[0].featureIndex].properties.rawSourceFeatureIds??[])provenance.push({sourceId:'natural-earth-admin0-countries-10m',sourceVersion:p.sourceVersion,sourceFeatureId,boundaryKind:'project-game-seed-derived-2020',operationalOnly:false});
    const tuple=p=>[p.sourceId,p.sourceVersion,p.sourceFeatureId,p.boundaryKind,String(p.operationalOnly)];
    provenance.sort((a,b)=>{const x=tuple(a),y=tuple(b);for(let i=0;i<x.length;i++){const c=compareText(x[i],y[i]);if(c)return c;}return 0;});
    const id=territoryIdForAtom(atom.canonicalAtomKey);
    entries.push({id,sourceCountryId:p.sourceCountryId,canonicalAtomKey:atom.canonicalAtomKey,geometryRef:`geometry.geojson#${id}`,
      bbox:atom.bbox,centroid:atom.centroid,area:atom.area,provenanceIds:provenance.map(add),componentMembership:atom.members,
      renderFeatureRef:{sourceType:'vector',sourceId:'world-territory-catalog',sourceLayer:'territories',featureId:id}});
  }
  entries.sort((a,b)=>compareText(a.id,b.id));
  if(new Set(entries.map(e=>e.id)).size!==entries.length)throw new Error('Duplicate TerritoryId');
  return {entries,provenanceById};
}
export function buildCatalogArtifacts({atoms,inputs,validation,generatorFiles,output,onProgress=()=>{},maxZoom=6}) {
  if(validation.pass!==true)throw new Error('Full atom validation is required');
  // No artifact or public file is emitted before the complete source boundary hard gate.
  const topology=buildCatalogTopology(atoms,inputs.p0,onProgress);
  const {entries,provenanceById}=makeCatalogEntries(atoms,inputs);
  const atomById=new Map(atoms.map(a=>[territoryIdForAtom(a.canonicalAtomKey),a]));
  const territories={type:'FeatureCollection',features:entries.map((e,i)=>({type:'Feature',id:i+1,
    properties:{territoryId:e.id,sourceCountryId:e.sourceCountryId},geometry:atomById.get(e.id).geometry}))};
  const edgeFeatures={type:'FeatureCollection',features:topology.edges.map((e,i)=>({type:'Feature',id:i+1,
    properties:{edgeId:e.id,leftTerritoryId:e.leftTerritoryId,rightTerritoryId:e.rightTerritoryId??'',boundaryClass:e.boundaryClass},geometry:e.geometry}))};
  const geometryBytes=jsonBytes(territories),topologyBytes=jsonBytes(topology);
  const geometryRoot=rootBytes('catalog-geometry.v1',geometryBytes),topologyRoot=rootBytes('catalog-topology.v1',topologyBytes);
  const generatorIdentity={files:generatorFiles,policy:CATALOG_POLICY,renderPolicy:RENDER_POLICY,sourceLock:inputs.lock,maxZoom};
  const catalogVersion=`catalog-v1-${hashCanonical('catalog-version.v1',{generatorIdentity,geometryRoot,topologyRoot}).slice(0,32)}`;
  const base=`public/data/territory-catalog/${catalogVersion}`,buildBase=`build-only/${catalogVersion}`;
  const buildArtifacts=[writeArtifact(output,`${buildBase}/geometry.geojson`,geometryBytes),writeArtifact(output,`${buildBase}/topology.json`,topologyBytes),
    writeArtifact(output,`${buildBase}/catalog.json`,jsonBytes({entries,provenanceById,territoryOrder:entries.map(e=>e.id)})),
    writeArtifact(output,`${buildBase}/validation.json`,jsonBytes(validation))];
  const options={...RENDER_POLICY.tileOptions,maxZoom};
  const territoryIndex=geojsonVt(territories,options),edgeIndex=geojsonVt(edgeFeatures,options);
  const tileArtifacts=[],decodedIds={territories:new Set(),edges:new Set()},tileCountsByZoom=[];
  const transportIds={territories:territories.features.map(f=>f.properties.territoryId),edges:edgeFeatures.features.map(f=>f.properties.edgeId)};
  for(let z=0;z<=maxZoom;z++){
    let bytes=0,nonempty=0;
    for(let x=0;x<2**z;x++)for(let y=0;y<2**z;y++){
      const layers={};for(const [name,index] of [['territories',territoryIndex],['edges',edgeIndex]]){const tile=index.getTile(z,x,y);if(tile?.features.length)layers[name]=tile;}
      const buffer=Buffer.from(fromGeojsonVt(layers,{version:2,extent:options.extent}));
      const decoded=new VectorTile(new PbfReader(buffer));
      for(const [name,layer] of Object.entries(decoded.layers)){
        if(!['territories','edges'].includes(name))throw new Error('Unexpected vector layer');
        for(let i=0;i<layer.length;i++){
          const f=layer.feature(i),key=name==='territories'?'territoryId':'edgeId';
          if(!Number.isSafeInteger(f.id)||f.id<1||transportIds[name][f.id-1]!==f.properties[key])throw new Error('PBF feature ID/properties lost canonical mapping');
          decodedIds[name].add(f.properties[key]);
        }
      }
      const artifact=writeArtifact(output,`${base}/tiles/${z}/${x}/${y}.pbf`,buffer);tileArtifacts.push(artifact);bytes+=buffer.length;if(buffer.length)nonempty++;
    }
    tileCountsByZoom.push({zoom:z,tiles:4**z,nonempty,byteLength:bytes});onProgress(`render z${z}: ${nonempty}/${4**z} nonempty tiles, ${bytes} bytes`);
  }
  const renderArtifactRoot=hashCanonical('catalog-render.v1',{policy:RENDER_POLICY,artifacts:tileArtifacts});
  const tileIndex=writeArtifact(output,`${base}/tile-index.json`,jsonBytes({artifacts:tileArtifacts,renderArtifactRoot}));
  const ref={catalogVersion,geometryRoot,topologyRoot,renderArtifactRoot,manifestPath:`/data/territory-catalog/${catalogVersion}/manifest.json`};
  const manifest={schemaVersion:'world-geometry-catalog-v1',ref,territoryCount:entries.length,edgeCount:topology.edges.length,
    minZoom:0,maxZoom,sourceId:'world-territory-catalog',sourceLayers:['territories','edges'],promoteId:{territories:'territoryId',edges:'edgeId'},
    tileTemplate:`/data/territory-catalog/${catalogVersion}/tiles/{z}/{x}/{y}.pbf`,tileIndex,
    buildArtifacts,generatorIdentity,license:inputs.lock.license,attribution:inputs.lock.attribution};
  // The large source lock is stored only in build evidence; browser manifest carries its hash.
  delete manifest.generatorIdentity;manifest.generatorIdentityHash=hashCanonical('catalog-generator.v1',generatorIdentity);
  const manifestArtifact=writeArtifact(output,`${base}/manifest.json`,jsonBytes(manifest));
  const evidence={status:'pass',ref,buildArtifacts,manifestArtifact,tileIndex,tileCountsByZoom,
    renderBytes:tileArtifacts.reduce((n,a)=>n+a.byteLength,0),renderArtifactCount:tileArtifacts.length,
    decodedCanonicalFeatureIds:{territories:decodedIds.territories.size,edges:decodedIds.edges.size},topology:topology.evidence};
  writeArtifact(output,'artifact-index.json',jsonBytes({ref,artifacts:[...buildArtifacts,tileIndex,manifestArtifact,...tileArtifacts]}));
  writeArtifact(output,'build-evidence.json',jsonBytes(evidence));return evidence;
}
export function verifyCatalogArtifactBytes(directory){
  const index=JSON.parse(fs.readFileSync(path.join(directory,'artifact-index.json'),'utf8'));
  if(new Set(index.artifacts.map(a=>a.path)).size!==index.artifacts.length)throw new Error('Duplicate artifact path');
  for(const a of index.artifacts){if(a.path.split('/').includes('..')||path.isAbsolute(a.path))throw new Error('Unsafe artifact path');const bytes=fs.readFileSync(path.join(directory,a.path));if(bytes.length!==a.byteLength||digest(bytes)!==a.sha256)throw new Error(`Artifact bytes mismatch: ${a.path}`);}
  const prefix=`build-only/${index.ref.catalogVersion}`;
  for(const [name,domain,key]of [['geometry.geojson','catalog-geometry.v1','geometryRoot'],['topology.json','catalog-topology.v1','topologyRoot']])if(rootBytes(domain,fs.readFileSync(path.join(directory,prefix,name)))!==index.ref[key])throw new Error(`${key} mismatch`);
  const tiles=index.artifacts.filter(a=>a.path.endsWith('.pbf'));
  if(hashCanonical('catalog-render.v1',{policy:RENDER_POLICY,artifacts:tiles})!==index.ref.renderArtifactRoot)throw new Error('renderArtifactRoot mismatch');
  const base=`public/data/territory-catalog/${index.ref.catalogVersion}`;
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,base,'manifest.json'),'utf8'));
  const tileIndex=JSON.parse(fs.readFileSync(path.join(directory,base,'tile-index.json'),'utf8'));
  if(canonical(manifest.ref)!==canonical(index.ref)||canonical(tileIndex.artifacts)!==canonical(tiles)||tileIndex.renderArtifactRoot!==index.ref.renderArtifactRoot)throw new Error('Manifest/tile index root mismatch');
  const expected=[];for(let z=0;z<=manifest.maxZoom;z++)for(let x=0;x<2**z;x++)for(let y=0;y<2**z;y++)expected.push(`${base}/tiles/${z}/${x}/${y}.pbf`);
  if(canonical(expected)!==canonical(tiles.map(a=>a.path)))throw new Error('Incomplete zoom tile set');
  if(index.artifacts.some(a=>a.path.startsWith('public/')&&!a.path.endsWith('.pbf')&&!a.path.endsWith('/manifest.json')&&!a.path.endsWith('/tile-index.json')))throw new Error('Build-only payload exposed as browser artifact');
  const catalog=JSON.parse(fs.readFileSync(path.join(directory,prefix,'catalog.json'),'utf8'));
  const topology=JSON.parse(fs.readFileSync(path.join(directory,prefix,'topology.json'),'utf8'));
  const ids={territories:catalog.entries.map(e=>e.id),edges:topology.edges.map(e=>e.id)},seen={territories:new Set(),edges:new Set()};
  for(const a of tiles){const tile=new VectorTile(new PbfReader(fs.readFileSync(path.join(directory,a.path))));
    for(const [name,layer]of Object.entries(tile.layers)){
      if(!Object.hasOwn(ids,name))throw new Error('Unexpected PBF source layer');
      const key=name==='territories'?'territoryId':'edgeId';
      for(let i=0;i<layer.length;i++){const f=layer.feature(i);if(!Number.isSafeInteger(f.id)||f.id<1||ids[name][f.id-1]!==f.properties[key])throw new Error('Canonical PBF ID mapping mismatch');seen[name].add(f.properties[key]);}
    }
  }
  return {pass:true,verifiedArtifactCount:index.artifacts.length,decodedCanonicalFeatureIds:{territories:seen.territories.size,edges:seen.edges.size},ref:index.ref};
}
export function compareCatalogDirectories(first,second){
  const a=verifyCatalogArtifactBytes(first),b=verifyCatalogArtifactBytes(second);
  if(canonical(a)!==canonical(b))throw new Error('Independent roots/artifact counts differ');
  const index=JSON.parse(fs.readFileSync(path.join(first,'artifact-index.json'),'utf8'));
  const extra=['source-lock.json','source-replay-evidence.json'].filter(p=>fs.existsSync(path.join(first,p))||fs.existsSync(path.join(second,p)));
  for(const name of ['artifact-index.json','build-evidence.json',...extra,...index.artifacts.map(a=>a.path)])if(!fs.readFileSync(path.join(first,name)).equals(fs.readFileSync(path.join(second,name))))throw new Error(`Independent artifact bytes differ: ${name}`);
  return {pass:true,comparedArtifactCount:index.artifacts.length+2,ref:a.ref};
}
