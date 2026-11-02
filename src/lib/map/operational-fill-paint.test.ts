// @vitest-environment node
import {expect, it} from 'vitest';
import {createExpression} from '@maplibre/maplibre-gl-style-spec';
import {OPERATIONAL_FILL_COLOR} from './operational-fill-paint';

it('composes every occupation/hover/selection combination like the original ordered alpha overlays', () => {
  const expression = createExpression(OPERATIONAL_FILL_COLOR);
  if (expression.result !== 'success') throw Error(JSON.stringify(expression.value));
  const base = [0x27,0x65,0xa3], selection = [0xe1,0xc4,0x91], occupation = [0x40,0x28,0x5e];
  for (let bits=0;bits<8;bits++) {
    const occupied=!!(bits&1),hover=!!(bits&2),selected=!!(bits&4);
    let expected=base.map(v=>v/255);
    for (const [active,tint] of [[occupied,occupation],[hover,selection],[selected,selection]] as const)
      if(active)expected=expected.map((v,i)=>v*.82+tint[i]/255*.18);
    const actual=expression.value.evaluate({zoom:3},{type:'Polygon',properties:{}},{mapColor:'#2765A3',selectionColor:'#E1C491',occupied,hover,selected});
    for (const [i,key] of ['r','g','b'].entries())expect(actual[key]).toBeCloseTo(expected[i],10);
    expect(actual.a).toBe(1);
  }
});
