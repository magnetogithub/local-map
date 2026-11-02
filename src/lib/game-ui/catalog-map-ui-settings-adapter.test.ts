import {describe,it,expect,vi} from 'vitest';
import {applyCatalogMapUiSettings} from './catalog-map-ui-settings-adapter';
import {DEFAULT_GAME_UI_SETTINGS} from './ui-settings';
import {CATALOG_MAP_LAYER_IDS as L} from '../map/catalog-map-consumer';
describe('catalog map UI settings',()=>{
  it('applies settings after missing layers are created, emphasizes only country boundaries and restores widths',()=>{
    const layers=new Set<string>(),target={getLayer:(id:string)=>layers.has(id),setLayoutProperty:vi.fn(),setPaintProperty:vi.fn()};
    const selected={...DEFAULT_GAME_UI_SETTINGS,emphasizeBorders:true,showCountryLabels:false,showCapitalMarkers:false,reduceMotion:true};
    applyCatalogMapUiSettings(target,selected);expect(target.setPaintProperty).not.toHaveBeenCalled();
    for(const id of [L.edges,L.labels,L.capitals])layers.add(id);
    applyCatalogMapUiSettings(target,selected);
    expect(target.setLayoutProperty.mock.calls).toEqual([[L.labels,'visibility','none'],[L.capitals,'visibility','none']]);
    expect(target.setPaintProperty).toHaveBeenLastCalledWith(L.edges,'line-width',['case',['==',['get','boundaryClass'],'administrative'],0.3,['case',['==',['get','boundaryClass'],'country'],1.6,0.8]]);
    applyCatalogMapUiSettings(target,DEFAULT_GAME_UI_SETTINGS);
    expect(target.setPaintProperty).toHaveBeenLastCalledWith(L.edges,'line-width',['case',['==',['get','boundaryClass'],'administrative'],0.3,['case',['==',['get','boundaryClass'],'country'],0.8,0.8]]);
    expect(target.setLayoutProperty).toHaveBeenCalledWith(L.labels,'visibility','visible');expect(target.setLayoutProperty).toHaveBeenCalledWith(L.capitals,'visibility','visible');
  });
});
