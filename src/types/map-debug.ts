export type DetailedMapStatus="idle"|"loading"|"ready"|"error";
export type RenderedCountryLabel={countryId:string;layerId:string;anchor:[number,number];angle:number;fontSize:number;letterSpacing:number;worldCopy?:number;screenAnchor:[number,number];estimatedWidth:number};
export type RenderedCountryLabelBounds={countryId:string;layerId:string;worldCopy:number;source:"projected-glyph-polygons";renderer:"glyph-geometry";left:number;top:number;right:number;bottom:number;width:number;height:number;primitiveCount:number;labelInstanceId:string;glyphIndices:number[];vertexCount:number;diagnostic:false};
export type PaxMapDebug={
  getCenter:()=>[number,number];getZoom:()=>number;hasLayer:(id:string)=>boolean;
  queryRenderedCountryIds:()=>string[];queryRenderedLabelIds:()=>string[];
  getRawRenderedCountryLabels:()=>RenderedCountryLabel[];getRenderedCountryLabels:()=>RenderedCountryLabel[];getRenderedCountryLabelCount:(countryId:string,options?:{raw?:boolean})=>number;getCountryLabelPlacement:(countryId:string)=>Record<string,unknown>|null;
  getCountryLabelRendererBounds?:(countryId:string)=>RenderedCountryLabelBounds[];
  getCountryEffectiveScreenWidth?:(countryId:string)=>number|null;
  getCountryLabelFontConfiguration?:()=>{textFont:unknown;glyphSource:string|undefined;localIdeographFontFamily:string};
  showOnlyCountryLabel?:(countryId:string|null)=>void;
  getGlyphLabelFeatureCount?:(countryId?:string)=>number;
  getGlyphLabelInstanceCount?:(countryId?:string)=>number;
  getRenderedGlyphLabelIds?:()=>string[];
  getCountryLabelLayerOrder?:()=>string[];
  setCountryInteractionState?:(state:{hoveredCountryId?:string|null;selectedCountryId?:string|null;playerCountryId?:string|null})=>void;
  setEvidenceSourceData?:(sourceId:string,data:unknown)=>boolean;
  splitChinaIntoProvinceCountries?:()=>Promise<{active:true;provinceCountryIds:string[]}>;
  rollbackChinaProvinceCountries?:()=>Promise<{active:false;restoredCountryId:"CHN"}>;
  getChinaProvinceScenario?:()=>{active:boolean;provinceCountryIds:string[]};
  getSelectedFilter:()=>unknown;getPlayerFilter:()=>unknown;
  getAdmin1Count:(countryId:string)=>number;getUnresolvedAdmin1:()=>unknown[];
  getDetailedStatus:()=>DetailedMapStatus;getDetailedError:()=>string|null;
  jumpTo:(center:[number,number],zoom?:number)=>void;
  queryFeaturesAt:(point:[number,number])=>Array<{layerId:string;source:string;countryId?:string;admin1Id?:string;geometryType?:string}>;
  getRenderedLayersAt:(point:[number,number])=>string[];setLayerVisibility:(layerId:string,visible:boolean)=>void;
  project:(lngLat:[number,number])=>[number,number];isRenderSettled:()=>boolean;
};
declare global{interface Window{__PAX_MAP_DEBUG__?:PaxMapDebug}}
