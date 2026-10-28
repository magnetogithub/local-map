import {OperationalGameSetupShell} from './OperationalGameSetupShell';
import {resolveRegressionPage} from '@/lib/world/regression-page.server';

type Props = Readonly<{mode: "setup" | "game"}>;

export async function WorldAppPage({mode}: Props) {
  const regressionPage=await resolveRegressionPage(mode);
  if(regressionPage)return regressionPage;
  return <OperationalGameSetupShell mode={mode}/>;
}
