import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {prepareCatalogConsumerBootstrap} from '../map/catalog-consumer.server';
import {readCatalogConsumerMetadata} from '../map/catalog-consumer-contract';
import {catalogContractForConsumer} from '../projection/catalog-map-consumer-projection';
import {readCatalogRuntimePair} from '../simulation/catalog-runtime';
export function prepareProductionCatalogSeed(root=process.cwd(),read:(file:string)=>Buffer=file=>fs.readFileSync(file)){
  const bootstrap=prepareCatalogConsumerBootstrap(root,read),version=bootstrap.catalogRef.catalogVersion;
  const report=JSON.parse(read(path.join(root,'reports/prompt14/14-08-immutable-catalog-checkpoint.json')).toString('utf8'));
  const proof=report.stages['14-8'].migration;
  if(report.status!=='pass'||proof.status!=='pass')throw new Error('Production seed migration is not approved');
  const raw=read(path.join(root,`data/catalogs/prompt14/${version}/migration-pair.json`));
  if(createHash('sha256').update(raw).digest('hex')!==proof.pairSha256)throw new Error('Production seed differs from approved migration bytes');
  const metadata=readCatalogConsumerMetadata(JSON.parse(read(path.join(root,`public/data/territory-catalog/${version}/consumer-metadata.json`)).toString('utf8')),bootstrap.catalogRef);
  const seed=readCatalogRuntimePair(raw.toString('utf8'),catalogContractForConsumer(metadata));
  if(seed.world.revision!==0||seed.simulation.revision!==0||seed.simulation.currentDate!=='2020-01-01'||seed.simulation.turnNumber!==0||seed.simulation.territorialControlAuthorityOrder.length||seed.simulation.countryPresentationAuthorityOrder.length)throw new Error('Production initial seed is not the canonical 2020 pair');
  return Object.freeze({bootstrap,serializedPair:raw.toString('utf8')});
}
let approved:ReturnType<typeof prepareProductionCatalogSeed>|undefined;
export function loadProductionCatalogSeed(){return approved??=prepareProductionCatalogSeed();}
