import {CATALOG_MAP_LAYER_IDS as L} from '../map/catalog-map-consumer';
import type {MapUiSettingsTarget} from './map-ui-settings-adapter';
import type {GameUiSettings} from './ui-settings';

export function applyCatalogMapUiSettings(target:MapUiSettingsTarget,settings:GameUiSettings):void{
  for(const [id,visible]of [[L.labels,settings.showCountryLabels],[L.capitals,settings.showCapitalMarkers]] as const){
    if(target.getLayer(id))target.setLayoutProperty(id,'visibility',visible?'visible':'none');
  }
  if(target.getLayer(L.edges))target.setPaintProperty(L.edges,'line-width',
    ['case',['==',['get','boundaryClass'],'administrative'],0.3,
      ['case',['==',['get','boundaryClass'],'country'],settings.emphasizeBorders?1.6:0.8,0.8]]);
}
