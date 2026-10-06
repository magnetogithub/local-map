import 'server-only';
import {cookies} from 'next/headers';
import {LegacyRegressionPage} from './legacy-regression-page';

export async function resolveRegressionPage(mode: 'setup' | 'game') {
  if(process.env.NEXT_PUBLIC_PAX_E2E!=='1')return null;
  if((await cookies()).get('pax-legacy-regression')?.value!=='1')return null;
  return <LegacyRegressionPage mode={mode}/>;
}
