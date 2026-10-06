import {CatalogGameSetupShell} from './CatalogGameSetupShell';
import {loadProductionCatalogSeed} from '@/lib/world/production-catalog-seed.server';
import {resolveRegressionPage} from '@/lib/world/regression-page.server';

type Props = Readonly<{mode: "setup" | "game"}>;

export async function WorldAppPage({mode}: Props) {
  const regressionPage=await resolveRegressionPage(mode);
  if(regressionPage)return regressionPage;
  let initial:ReturnType<typeof loadProductionCatalogSeed>|undefined;
  try{initial=loadProductionCatalogSeed();}catch{initial=undefined;}
  if(!initial)return <main className="route-loading" role="alert">지도와 시뮬레이션 데이터를 불러올 수 없습니다. 잠시 후 다시 시도하세요.</main>;
  return <CatalogGameSetupShell mode={mode} {...initial}/>;
}
