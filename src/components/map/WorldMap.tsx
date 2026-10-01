"use client";

import {useCallback,useEffect,useRef,useState} from "react";
import {Map as MapLibreMap,NavigationControl,type FilterSpecification,type GeoJSONSource,type MapGeoJSONFeature,type StyleSpecification} from "maplibre-gl";
import {MapSourceIncrementalController,RUNTIME_MAP_SOURCE_IDS,type RuntimeMapSourceId} from "@/lib/map/map-source-incremental-adapter";
import {attachScenarioDebugTools} from "@/lib/map/scenario-debug-bridge";
import {nearestWrappedLongitude} from "@/lib/map/country-camera";
import {DETAIL_ZOOM,EMPTY_WAR_MAP_SOURCE,MAP_LAYER_IDS as L,MAP_OPTIONS,MAP_SOURCE_IDS as S} from "@/lib/map/map-config";
import {POINT_LABEL_MIN_WORLD_UNITS,worldSpaceFontSize,worldSpaceTextSizeExpression} from "@/lib/map/country-label-size";
import {shouldApplyCountryMapMarkerProjection,type CountryMapMarkerProjection} from "@/lib/projection/country-map-marker-projection";
import {projectLabelMapSources,shouldApplyLabelMapSources,type LabelSeedCache} from "@/lib/projection/country-label-runtime-projection";
import type {LabelProjection} from "@/lib/projection/label-projection-checkpoint";
import type {WorldMapRuntimeProjection} from "@/lib/projection/world-map-runtime-projection";
import type {WorldStateStoreController} from "@/stores/world-state-store";
import {useGameSetupStore} from "@/stores/game-setup-store";
import {DEFAULT_GAME_UI_SETTINGS,type GameUiSettings} from "@/lib/game-ui/ui-settings";
import {applyMapUiSettings,type MapUiSettingsTarget} from "@/lib/game-ui/map-ui-settings-adapter";
import labelMetrics from "@/data/country-label-metrics-2020.json";
import type {DetailedMapStatus,RenderedCountryLabel,RenderedCountryLabelBounds} from "@/types/map-debug";

type GlyphCoordinate=[number,number];
type GlyphGeometry={type:"Polygon"|"MultiPolygon";coordinates:GlyphCoordinate[][][]|GlyphCoordinate[][][][]};
type GlyphGeoJSONFeature={geometry:GlyphGeometry;properties:{countryId:string;labelInstanceId:string;glyphIndex:number;role:"fill"|"outline"}};
type CountryGeometryFeature={geometry:{type:string;coordinates:unknown};properties:{countryId?:unknown}};

const fillColor:["coalesce",["get","mapColor"],string]=["coalesce",["get","mapColor"],"#c9d8b6"];
const emptyFilter:["==",["get","countryId"],string]=["==",["get","countryId"],""];
const highlightPaint={"line-color":"#fffdf2","line-width":2} as const;
const WHITE_POINT_LABEL_PAINT={"text-color":"#ffffff","text-halo-color":"#ffffff","text-halo-width":1,"text-halo-blur":0} as const;
const POINT_LABEL_MODE="small-country-point";
const pointWorldSpaceLabelSize=worldSpaceTextSizeExpression(POINT_LABEL_MIN_WORLD_UNITS);
const isPosition=(value:unknown):value is [number,number]=>Array.isArray(value)&&value.length>=2&&typeof value[0]==="number"&&typeof value[1]==="number";
const ringContainsPoint=(ring:unknown,point:[number,number])=>{if(!Array.isArray(ring))return false;let inside=false;for(let index=0,previous=ring.length-1;index<ring.length;previous=index++){const currentPoint=ring[index],previousPoint=ring[previous];if(!isPosition(currentPoint)||!isPosition(previousPoint))continue;const intersects=(currentPoint[1]>point[1])!==(previousPoint[1]>point[1])&&point[0]<(previousPoint[0]-currentPoint[0])*(point[1]-currentPoint[1])/(previousPoint[1]-currentPoint[1])+currentPoint[0];if(intersects)inside=!inside}return inside};
const polygonContainsPoint=(polygon:unknown,point:[number,number])=>Array.isArray(polygon)&&ringContainsPoint(polygon[0],point)&&!polygon.slice(1).some(ring=>ringContainsPoint(ring,point));
const featureContainsPoint=(feature:CountryGeometryFeature,point:[number,number])=>{const geometry=feature.geometry;if(geometry.type==="Polygon")return polygonContainsPoint(geometry.coordinates,point);if(geometry.type==="MultiPolygon"&&Array.isArray(geometry.coordinates))return geometry.coordinates.some(polygon=>polygonContainsPoint(polygon,point));return false};
const sourceFeatureCountryAt=(features:readonly CountryGeometryFeature[],point:[number,number])=>features.find(feature=>typeof feature.properties?.countryId==="string"&&featureContainsPoint(feature,point))?.properties?.countryId as string|undefined;

const baseStyle:StyleSpecification={version:8,glyphs:"/fonts/{fontstack}/{range}.pbf",sources:{
  [S.countriesLow]:{type:"geojson",data:{type:"FeatureCollection",features:[]}},
  [S.bordersLow]:{type:"geojson",data:{type:"FeatureCollection",features:[]}},
  [S.labels]:{type:"geojson",data:{type:"FeatureCollection",features:[]},promoteId:"countryId"},
  [S.glyphLabelFills]:{type:"geojson",data:{type:"FeatureCollection",features:[]}},
  [S.glyphLabelOutlines]:{type:"geojson",data:{type:"FeatureCollection",features:[]}},
  [S.capitals]:{type:"geojson",data:{type:"FeatureCollection",features:[]}},
  [S.smallCountries]:{type:"geojson",data:{type:"FeatureCollection",features:[]}},
  [S.wars]:{type:"geojson",data:EMPTY_WAR_MAP_SOURCE},
},layers:[
  {id:"sea-background",type:"background",paint:{"background-color":"#b8d2da"}},
  {id:L.countryLow,type:"fill",source:S.countriesLow,paint:{"fill-color":fillColor,"fill-opacity":.92}},
  {id:L.bordersLow,type:"line",source:S.bordersLow,paint:{"line-color":"#536266","line-width":["interpolate",["linear"],["zoom"],1,.45,3,.8]}},
  {id:L.hoverLow,type:"line",source:S.bordersLow,paint:highlightPaint,filter:emptyFilter},
  {id:L.selectedLow,type:"line",source:S.bordersLow,paint:{"line-color":"#173f55","line-width":3},filter:emptyFilter},
  {id:L.playerLow,type:"line",source:S.bordersLow,paint:{"line-color":"#c1882e","line-width":4,"line-dasharray":[2,1]},filter:emptyFilter},
  {id:L.warAreas,type:"fill",source:S.wars,filter:["==",["get","kind"],"occupation"],layout:{visibility:"none"},paint:{"fill-color":"#8d4c43","fill-opacity":.24}},
  {id:L.warFronts,type:"line",source:S.wars,filter:["==",["get","kind"],"front"],layout:{visibility:"none"},paint:{"line-color":"#8d4c43","line-width":3,"line-dasharray":[2,1]}},
  {id:L.glyphLabelOutlines,type:"line",source:S.glyphLabelOutlines,minzoom:1,layout:{visibility:"visible"},paint:{"line-color":"#ffffff","line-width":1,"line-opacity":1}},
  {id:L.glyphLabelFills,type:"fill",source:S.glyphLabelFills,minzoom:1,layout:{visibility:"visible"},paint:{"fill-color":"#ffffff","fill-outline-color":"#ffffff","fill-opacity":1}},
  {id:L.smallLabels,type:"symbol",source:S.labels,minzoom:1,filter:["all",["==",["get","placementMode"],POINT_LABEL_MODE],["==",["get","overlapAtClose"],false]],layout:{"text-field":["get","mapLabelKo"],"text-font":["Open Sans Regular"],"text-size":pointWorldSpaceLabelSize,"text-letter-spacing":["get","letterSpacing"],"text-rotate":["get","angle"],"text-rotation-alignment":"map","text-keep-upright":true,"text-padding":2,"text-allow-overlap":false,"text-ignore-placement":false,"symbol-sort-key":["get","priority"]},paint:WHITE_POINT_LABEL_PAINT},
  {id:L.ultraSmallLabels,type:"symbol",source:S.labels,minzoom:1,filter:["all",["==",["get","placementMode"],POINT_LABEL_MODE],["==",["get","overlapAtClose"],true]],layout:{"text-field":["get","mapLabelKo"],"text-font":["Open Sans Regular"],"text-size":pointWorldSpaceLabelSize,"text-letter-spacing":["get","letterSpacing"],"text-rotate":["get","angle"],"text-rotation-alignment":"map","text-keep-upright":true,"text-padding":2,"text-allow-overlap":true,"text-ignore-placement":false,"symbol-sort-key":["get","priority"]},paint:WHITE_POINT_LABEL_PAINT},
  {id:L.capitalDots,type:"circle",source:S.capitals,minzoom:2.3,paint:{"circle-radius":["interpolate",["linear"],["zoom"],2.3,2,6,3.5],"circle-color":"#293b43","circle-stroke-color":"#fff","circle-stroke-width":1}},
  {id:L.capitalLabels,type:"symbol",source:S.capitals,minzoom:3.2,layout:{"text-field":["get","nameKo"],"text-font":["Open Sans Regular"],"text-size":10,"text-offset":[0,.9],"text-anchor":"top","text-optional":true},paint:{"text-color":"#34464d","text-halo-color":"#f4f0e6","text-halo-width":1}},
  {id:L.smallMarkers,type:"circle",source:S.smallCountries,maxzoom:7,paint:{"circle-radius":4,"circle-color":"#f8f4e8","circle-stroke-color":"#334b57","circle-stroke-width":1.5}},
]};

export function WorldMap({worldController,mapProjection,initialMarkerProjection,labelProjection,uiSettings=DEFAULT_GAME_UI_SETTINGS}:{worldController:WorldStateStoreController;mapProjection:WorldMapRuntimeProjection;initialMarkerProjection:CountryMapMarkerProjection;labelProjection:LabelProjection;uiSettings?:GameUiSettings}){
  const container=useRef<HTMLDivElement>(null),mapRef=useRef<MapLibreMap|null>(null),detailPromise=useRef<Promise<void>|null>(null),detailStatusRef=useRef<DetailedMapStatus>("idle"),detailErrorRef=useRef<string|null>(null),adminCounts=useRef(new Map<string,number>()),unresolved=useRef<unknown[]>([]);
  const markerProjectionRef=useRef(initialMarkerProjection),markerRevisionRef=useRef(-1);
  const labelProjectionRef=useRef(labelProjection),seedLabelProjectionRef=useRef(labelProjection),labelRevisionRef=useRef(-1),applyLabelRuntimeRef=useRef<(()=>void)|null>(null);
  const mapProjectionRef=useRef(mapProjection),mapRevisionRef=useRef(-1),applyMapRuntimeRef=useRef<(()=>void)|null>(null);
  const mapUiSettingsRef=useRef(uiSettings),applyMapUiSettingsRef=useRef<(()=>void)|null>(null);
  const [status,setStatus]=useState<"loading"|"ready"|"error">("loading"),[detailStatus,setDetailStatus]=useState<DetailedMapStatus>("idle");
  const selected=useGameSetupStore(s=>s.selectedCountryId),player=useGameSetupStore(s=>s.playerCountryId);
  const updateDetailStatus=useCallback((next:DetailedMapStatus,error:string|null=null)=>{detailStatusRef.current=next;detailErrorRef.current=error;setDetailStatus(next)},[]);

  useEffect(()=>{
    if(!container.current||mapRef.current)return;
    let disposed=false,hovered:string|null=null,mapStyleReady=false,initialRenderReady=false,glyphFeaturesReady=false,renderFramesRemaining=2,glyphFeatures:GlyphGeoJSONFeature[]=[],countryHighFeatures:CountryGeometryFeature[]=[],verifyingRevision=-1,verifiedRevision=-1,resyncPending=false,nextSourceIdentity=1;
    const sourceController=new MapSourceIncrementalController();
    const sourceIdentities=new WeakMap<object,number>();
    const map=new MapLibreMap({container:container.current,style:baseStyle,...MAP_OPTIONS,localIdeographFontFamily:"Noto Sans KR Local, Noto Sans KR, sans-serif",attributionControl:{customAttribution:"Natural Earth 1:50m / 1:10m"},dragRotate:false,pitchWithRotate:false});
    const countryById={get:(id:string)=>{const country=worldController.getState().countriesById[id];return country?{playable:country.politicalStatus==="sovereign"}:undefined}};
    let labelSeedCache:LabelSeedCache|null=null;
    const loadLabelSeed=async()=>{const paths=["/data/maps/country-labels-2020.geojson","/data/maps/country-label-glyph-fills-2020.geojson","/data/maps/country-label-glyph-outlines-2020.geojson"];const [placements,fills,outlines]=await Promise.all(paths.map(async path=>{const response=await fetch(path);if(!response.ok)throw new Error(`${path} HTTP ${response.status}`);return response.json()}));if(disposed)return;labelSeedCache={placements,fills,outlines};applyLabelRuntimeRef.current?.()};
    void loadLabelSeed().catch(error=>{console.error("Label seed cache failed",error)});
    mapRef.current=map;map.addControl(new NavigationControl({showCompass:false}),"top-right");
    const setFilterIfPresent=(id:string,filter:FilterSpecification)=>{if(map.getLayer(id))map.setFilter(id,filter)};
    applyMapUiSettingsRef.current=()=>applyMapUiSettings(map as unknown as MapUiSettingsTarget,mapUiSettingsRef.current);
    const requireRenderFrames=()=>{renderFramesRemaining=2;map.triggerRepaint()};
    const renderSettled=()=>glyphFeaturesReady&&!resyncPending&&!sourceController.snapshot().resyncRequired&&!map.isMoving()&&renderFramesRemaining===0&&map.loaded()&&(map.getZoom()<DETAIL_ZOOM||detailStatusRef.current==="ready");
    const markInitialReady=()=>{if(!initialRenderReady&&renderSettled()){initialRenderReady=true;setStatus("ready")}};
    const applyStateFilters=()=>{const state=useGameSetupStore.getState(),selectedFilter:["==",["get","countryId"],string]=["==",["get","countryId"],state.selectedCountryId??""],playerFilter:["==",["get","countryId"],string]=["==",["get","countryId"],state.playerCountryId??""];for(const id of [L.selectedLow,L.selectedHigh])setFilterIfPresent(id,selectedFilter);for(const id of [L.playerLow,L.playerHigh])setFilterIfPresent(id,playerFilter)};
    const updateLabelFilter=()=>{const currentZoom=map.getZoom(),zoomFilter:["<=",["get","minZoom"],number]=["<=",["get","minZoom"],currentZoom];setFilterIfPresent(L.glyphLabelFills,zoomFilter);setFilterIfPresent(L.glyphLabelOutlines,zoomFilter);setFilterIfPresent(L.smallLabels,["all",zoomFilter,["==",["get","placementMode"],POINT_LABEL_MODE],["==",["get","overlapAtClose"],false]]);setFilterIfPresent(L.ultraSmallLabels,["all",zoomFilter,["==",["get","placementMode"],POINT_LABEL_MODE],["==",["get","overlapAtClose"],true]])};
    const setCountryHoverState=(countryId:string,hover:boolean)=>{for(const source of [S.countriesLow,S.countriesHigh]){if(!map.getSource(source))continue;for(const feature of mapProjectionRef.current.mapSources.low.featureCollection.features){if(feature.properties.ownerCountryId===countryId)map.setFeatureState({source,id:feature.id},{hover})}}};
    const clearHover=()=>{if(hovered)setCountryHoverState(hovered,false);hovered=null;useGameSetupStore.getState().setHoveredCountry(null);for(const id of [L.hoverLow,L.hoverHigh])setFilterIfPresent(id,emptyFilter);map.getCanvas().style.cursor=""};
    const hoverFeature=(_source:string,event:{features?:MapGeoJSONFeature[]})=>{const id=event.features?.[0]?.properties?.countryId as string|undefined;if(!id)return;if(hovered&&hovered!==id)clearHover();hovered=id;setCountryHoverState(id,true);useGameSetupStore.getState().setHoveredCountry(id);for(const layer of [L.hoverLow,L.hoverHigh])setFilterIfPresent(layer,["==",["get","countryId"],id]);map.getCanvas().style.cursor="pointer"};
    const selectFeature=(event:{features?:MapGeoJSONFeature[]})=>{const id=event.features?.[0]?.properties?.countryId as string|undefined;if(id&&worldController.getState().countriesById[id])useGameSetupStore.getState().selectCountry(id)};
    const bindHighInteraction=()=>{map.on("mousemove",L.countryHigh,e=>{if(map.getZoom()>=3)hoverFeature(S.countriesHigh,e)});map.on("mouseleave",L.countryHigh,clearHover);map.on("click",L.countryHigh,selectFeature)};
    const loadDetails=()=>{
      if(detailPromise.current)return detailPromise.current;
      updateDetailStatus("loading");
      detailPromise.current=Promise.all([
        fetch("/data/maps/admin1-boundaries-10m.geojson").then(r=>{if(!r.ok)throw new Error(`admin1 HTTP ${r.status}`);return r.json()}),
        fetch("/data/maps/admin1-validation-2020.json").then(r=>{if(!r.ok)throw new Error(`admin report HTTP ${r.status}`);return r.json()}),
      ]).then(([admin,report])=>{
        if(disposed)return;
        const projection=mapProjectionRef.current;countryHighFeatures=projection.countriesHigh.features as CountryGeometryFeature[];adminCounts.current=new Map(report.summary.map((row:{countryId:string;generatedBoundaryFeatureCount:number})=>[row.countryId,row.generatedBoundaryFeatureCount]));unresolved.current=report.unresolved;
        map.addSource(S.countriesHigh,{type:"geojson",data:{type:"FeatureCollection",features:[]}});map.addSource(S.bordersHigh,{type:"geojson",data:{type:"FeatureCollection",features:[]}});map.addSource(S.admin1,{type:"geojson",data:admin});
        map.addLayer({id:L.countryHigh,type:"fill",source:S.countriesHigh,minzoom:2.85,paint:{"fill-color":fillColor,"fill-opacity":["interpolate",["linear"],["zoom"],2.85,0,3,.92]}},L.hoverLow);
        map.addLayer({id:L.admin1,type:"line",source:S.admin1,minzoom:2.2,paint:{"line-color":"#ffffff","line-opacity":["interpolate",["linear"],["zoom"],2.2,0,3,.22,5,.52],"line-width":["interpolate",["linear"],["zoom"],2.2,.25,5,.85,7,1]}},L.hoverLow);
        map.addLayer({id:L.borders,type:"line",source:S.bordersHigh,minzoom:2.85,paint:{"line-color":"#46575c","line-width":["interpolate",["linear"],["zoom"],3,.8,6,1.8]}},L.hoverLow);
        map.addLayer({id:L.hoverHigh,type:"line",source:S.bordersHigh,minzoom:3,paint:highlightPaint,filter:emptyFilter},L.glyphLabelOutlines);
        map.addLayer({id:L.selectedHigh,type:"line",source:S.bordersHigh,minzoom:3,paint:{"line-color":"#173f55","line-width":3},filter:emptyFilter},L.glyphLabelOutlines);
        map.addLayer({id:L.playerHigh,type:"line",source:S.bordersHigh,minzoom:3,paint:{"line-color":"#c1882e","line-width":4,"line-dasharray":[2,1]},filter:emptyFilter},L.glyphLabelOutlines);
        map.setPaintProperty(L.countryLow,"fill-opacity",["interpolate",["linear"],["zoom"],2.85,.92,3,.18]);map.setPaintProperty(L.bordersLow,"line-opacity",["interpolate",["linear"],["zoom"],2.85,1,3,.2]);for(const id of [L.hoverLow,L.selectedLow,L.playerLow])map.setLayoutProperty(id,"visibility","none");
        bindHighInteraction();applyMapRuntimeRef.current?.();applyStateFilters();applyMapUiSettingsRef.current?.();updateDetailStatus("ready");
      }).catch(error=>{const message=error instanceof Error?error.message:String(error);console.error("상세 지도 데이터를 불러오지 못했습니다",error);detailPromise.current=null;updateDetailStatus("error",message)});
      return detailPromise.current;
    };
    const setSourceData=(sourceId:string,data:unknown)=>{const source=map.getSource(sourceId) as {setData?:(value:unknown)=>void}|undefined;if(!source?.setData)throw new Error(`GeoJSON source is unavailable: ${sourceId}`);source.setData(data)};
    const getRuntimeSource=(id:RuntimeMapSourceId)=>map.getSource(id) as GeoJSONSource|undefined;
    applyMapRuntimeRef.current=()=>{if(disposed||!mapStyleReady)return;const projection=mapProjectionRef.current;try{const applied=sourceController.synchronize(projection,getRuntimeSource);if(!applied)return;countryHighFeatures=projection.countriesHigh.features as CountryGeometryFeature[];mapRevisionRef.current=sourceController.snapshot().revision;verifiedRevision=-1;requireRenderFrames()}catch(error){console.error("Map source incremental synchronization failed",error);setStatus("error")}};
    applyLabelRuntimeRef.current=()=>{if(disposed||!mapStyleReady||!labelSeedCache)return;const sources=projectLabelMapSources(labelProjectionRef.current,seedLabelProjectionRef.current,labelSeedCache);if(!shouldApplyLabelMapSources(labelRevisionRef.current,sources))return;setSourceData(S.labels,sources.placements);setSourceData(S.glyphLabelFills,sources.fills);setSourceData(S.glyphLabelOutlines,sources.outlines);glyphFeatures=[...sources.fills.features] as unknown as GlyphGeoJSONFeature[];labelRevisionRef.current=sources.appliedRevision;glyphFeaturesReady=true;requireRenderFrames()};
    map.once("load",()=>{if(disposed)return;mapStyleReady=true;applyMapRuntimeRef.current?.();const markers=markerProjectionRef.current;setSourceData(S.capitals,markers.capitals);setSourceData(S.smallCountries,markers.smallCountryMarkers);markerRevisionRef.current=markers.appliedRevision;applyLabelRuntimeRef.current?.();map.moveLayer(L.smallLabels);map.moveLayer(L.ultraSmallLabels);requireRenderFrames();applyStateFilters();updateLabelFilter();applyMapUiSettingsRef.current?.();if(map.getZoom()>=DETAIL_ZOOM)void loadDetails()});
    map.on("styledata",()=>{if(mapStyleReady&&map.getSource(S.countriesLow)&&map.getSource(S.bordersLow))applyMapRuntimeRef.current?.()});
    map.on("zoom",updateLabelFilter);map.on("zoomend",()=>{if(map.getZoom()>=DETAIL_ZOOM)void loadDetails()});map.on("render",()=>{if(!map.isMoving()&&glyphFeaturesReady&&renderFramesRemaining>0){renderFramesRemaining--;if(renderFramesRemaining>0)map.triggerRepaint()}markInitialReady()});map.on("idle",()=>{markInitialReady();const revision=sourceController.snapshot().revision;if(revision<0||verifiedRevision===revision||verifyingRevision>=0)return;verifyingRevision=revision;void sourceController.verify(getRuntimeSource).then(ok=>{if(disposed)return;const snapshot=sourceController.snapshot();if(snapshot.revision!==revision)return;if(ok){verifiedRevision=revision;if(resyncPending){resyncPending=false;setStatus("ready")}}else if(snapshot.resyncRequired){resyncPending=false;console.error("Map source verification failed",snapshot.error);setStatus("error")}}).catch(error=>{if(disposed||sourceController.snapshot().revision!==revision)return;resyncPending=false;sourceController.fail(error);console.error("Map source verification failed",error);setStatus("error")}).finally(()=>{if(disposed)return;verifyingRevision=-1;if(sourceController.snapshot().revision!==revision)requireRenderFrames()})});map.on("error",event=>{console.error("MapLibre error",event.error);const sourceId=(event as {sourceId?:string}).sourceId;if(sourceId&&RUNTIME_MAP_SOURCE_IDS.some(id=>id===sourceId)){sourceController.fail(event.error);resyncPending=false;setStatus("error")}else if(!sourceId&&!mapStyleReady)setStatus("error")});
    map.on("mousemove",L.countryLow,e=>{if(detailStatusRef.current!=="ready")hoverFeature(S.countriesLow,e)});map.on("mouseleave",L.countryLow,clearHover);map.on("click",L.countryLow,e=>{if(detailStatusRef.current!=="ready")selectFeature(e)});map.on("click",L.smallMarkers,selectFeature);
    map.on("click",event=>{const layers=[detailStatusRef.current==="ready"?L.countryHigh:L.countryLow,L.countryLow,L.smallMarkers].filter(id=>!!map.getLayer(id));const features=map.queryRenderedFeatures(event.point,{layers});const paddedFeatures=features.length?features:map.queryRenderedFeatures([[event.point.x-12,event.point.y-12],[event.point.x+12,event.point.y+12]],{layers});const renderedId=paddedFeatures.find(feature=>typeof feature.properties?.countryId==="string")?.properties?.countryId as string|undefined;const lngLat=map.unproject(event.point),sourceId=detailStatusRef.current==="ready"&&map.getSource(S.countriesHigh)?S.countriesHigh:S.countriesLow,sourceFeatures:readonly CountryGeometryFeature[]=countryHighFeatures.length?countryHighFeatures:map.querySourceFeatures(sourceId) as unknown as CountryGeometryFeature[];const geometryId=sourceFeatureCountryAt(sourceFeatures,[lngLat.lng,lngLat.lat]);const id=renderedId??geometryId;if(id&&worldController.getState().countriesById[id])useGameSetupStore.getState().selectCountry(id);else useGameSetupStore.getState().clearSelectedCountry()});
    const focus=(event:Event)=>{const id=(event as CustomEvent<string>).detail;if(!worldController.getState().countriesById[id])return;const country=mapProjectionRef.current.focusByCountryId[id];if(!country)return;map.flyTo({center:[nearestWrappedLongitude(country.center[0],map.getCenter().lng),country.center[1]],zoom:country.zoom,duration:900})};
    const retry=()=>void loadDetails();window.addEventListener("pax:focus-country",focus);window.addEventListener("pax:retry-details",retry);const resize=new ResizeObserver(()=>map.resize());resize.observe(container.current);
    const rawRenderedCountryLabels=()=>{const zoom=map.getZoom(),center=map.getCenter().lng,result:RenderedCountryLabel[]=[];for(const feature of map.queryRenderedFeatures(undefined,{layers:[L.smallLabels,L.ultraSmallLabels]})){const p=feature.properties,id=String(p?.countryId??"");if(!id||feature.geometry.type!=="Point")continue;const anchor=feature.geometry.coordinates as [number,number],worldCopy=Math.round((center-anchor[0])/360),wrappedAnchor:[number,number]=[anchor[0]+worldCopy*360,anchor[1]],screen=map.project(wrappedAnchor),fontSize=worldSpaceFontSize(Number(p.fontSizeWorldUnits),zoom,POINT_LABEL_MIN_WORLD_UNITS),letterSpacing=Number(p.letterSpacing),textUnits=Number(p.targetTextWidthWorld??0)/Math.max(Number(p.fontSizeWorldUnits),1e-9),estimatedWidth=textUnits*fontSize;result.push({countryId:id,layerId:feature.layer.id,anchor,angle:Number(p.angle??0),fontSize,letterSpacing,worldCopy,screenAnchor:[screen.x,screen.y],estimatedWidth})}return result};
    const renderedCountryLabels=()=>{const unique=new Map<string,RenderedCountryLabel>();for(const label of rawRenderedCountryLabels()){const key=`${label.countryId}:${label.worldCopy}`;if(!unique.has(key))unique.set(key,label)}return [...unique.values()]};
    const glyphVertices=(geometry:GlyphGeometry)=>{const result:GlyphCoordinate[]=[];const visit=(value:unknown)=>{if(Array.isArray(value)&&value.length===2&&typeof value[0]==="number"&&typeof value[1]==="number")result.push(value as GlyphCoordinate);else if(Array.isArray(value))for(const child of value)visit(child)};visit(geometry.coordinates);return result};
    const glyphCountryLabelRendererBounds=(countryId:string)=>{const features=glyphFeatures.filter(feature=>feature.properties.countryId===countryId&&feature.properties.role==="fill"),groups=new Map<string,GlyphGeoJSONFeature[]>();for(const feature of features)groups.set(feature.properties.labelInstanceId,[...(groups.get(feature.properties.labelInstanceId)??[]),feature]);const anchor=(labelMetrics as unknown as Array<{countryId:string;anchor:[number,number]}>).find(metric=>metric.countryId===countryId)?.anchor,worldCopy=anchor?Math.round((map.getCenter().lng-anchor[0])/360):0,canvas=map.getCanvas();return [...groups].flatMap(([labelInstanceId,items])=>{const points=items.flatMap(item=>glyphVertices(item.geometry).map(([lng,lat])=>map.project([lng+worldCopy*360,lat])));if(!points.length)return[];const left=Math.min(...points.map(point=>point.x)),top=Math.min(...points.map(point=>point.y)),right=Math.max(...points.map(point=>point.x)),bottom=Math.max(...points.map(point=>point.y));if(right<0||bottom<0||left>canvas.width||top>canvas.height)return[];return[{countryId,layerId:L.glyphLabelFills,worldCopy,source:"projected-glyph-polygons",renderer:"glyph-geometry",labelInstanceId,glyphIndices:[...new Set(items.map(item=>item.properties.glyphIndex))].sort((a,b)=>a-b),diagnostic:false,left,top,right,bottom,width:right-left,height:bottom-top,primitiveCount:items.length,vertexCount:points.length} satisfies RenderedCountryLabelBounds]})};
    const countryLabelRendererBounds=(countryId:string)=>glyphCountryLabelRendererBounds(countryId);
    const countryEffectiveScreenWidth=(countryId:string)=>{const baseline=(labelMetrics as unknown as Array<{countryId:string;baseline:{coordinates:[number,number][]}}>).find(metric=>metric.countryId===countryId)?.baseline.coordinates;if(!baseline?.length)return null;const points=baseline.map(coordinate=>map.project(coordinate)),xs=points.map(point=>point.x),ys=points.map(point=>point.y);return Math.hypot(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys))};
    window.__PAX_MAP_DEBUG__={getCenter:()=>[map.getCenter().lng,map.getCenter().lat],getZoom:()=>map.getZoom(),hasLayer:id=>!!map.getLayer(id),queryRenderedCountryIds:()=>[...new Set(map.queryRenderedFeatures(undefined,{layers:[L.countryLow,L.countryHigh].filter(id=>!!map.getLayer(id))}).map(f=>f.properties?.countryId).filter(Boolean))],queryRenderedLabelIds:()=>[...new Set([...(window.__PAX_MAP_DEBUG__?.getRenderedGlyphLabelIds?.()??[]),...renderedCountryLabels().map(label=>label.countryId)].filter(id=>countryById.get(id)?.playable))],getRawRenderedCountryLabels:rawRenderedCountryLabels,getRenderedCountryLabels:renderedCountryLabels,getRenderedCountryLabelCount:(id,options)=>{const labels=options?.raw?rawRenderedCountryLabels():renderedCountryLabels();return labels.filter(label=>label.countryId===id).length},getCountryLabelPlacement:id=>(labelMetrics as Array<Record<string,unknown>>).find(metric=>metric.countryId===id)??null,getCountryFocus:id=>mapProjectionRef.current.focusByCountryId[id]??null,getCountryLabelRendererBounds:countryLabelRendererBounds,getCountryEffectiveScreenWidth:countryEffectiveScreenWidth,getSelectedFilter:()=>map.getFilter(detailStatusRef.current==="ready"?L.selectedHigh:L.selectedLow),getPlayerFilter:()=>map.getFilter(detailStatusRef.current==="ready"?L.playerHigh:L.playerLow),getAdmin1Count:id=>adminCounts.current.get(id)??0,getUnresolvedAdmin1:()=>unresolved.current,getDetailedStatus:()=>detailStatusRef.current,getDetailedError:()=>detailErrorRef.current,jumpTo:(center,zoom)=>{requireRenderFrames();map.jumpTo({center,zoom:zoom??map.getZoom()})},queryFeaturesAt:point=>map.queryRenderedFeatures(point).map(f=>({layerId:f.layer.id,source:f.source,countryId:f.properties?.countryId,admin1Id:f.properties?.admin1Id,geometryType:f.geometry.type})),getRenderedLayersAt:point=>[...new Set(map.queryRenderedFeatures(point).map(f=>f.layer.id))],setLayerVisibility:(id,visible)=>{if(map.getLayer(id))map.setLayoutProperty(id,"visibility",visible?"visible":"none")},project:lngLat=>{const p=map.project(lngLat);return[p.x,p.y]},isRenderSettled:renderSettled};
    window.__PAX_MAP_DEBUG__.getCountryLabelFontConfiguration=()=>({textFont:map.getLayoutProperty(L.smallLabels,"text-font"),glyphSource:map.getStyle().glyphs,localIdeographFontFamily:"Noto Sans KR Local"});window.__PAX_MAP_DEBUG__.showOnlyCountryLabel=id=>{if(id){for(const layer of [L.capitalLabels,L.capitalDots])if(map.getLayer(layer))map.setLayoutProperty(layer,"visibility","none");setFilterIfPresent(L.glyphLabelFills,["==",["get","countryId"],id]);setFilterIfPresent(L.glyphLabelOutlines,["==",["get","countryId"],id]);setFilterIfPresent(L.smallLabels,["all",["==",["get","countryId"],id],["==",["get","placementMode"],POINT_LABEL_MODE],["==",["get","overlapAtClose"],false]]);setFilterIfPresent(L.ultraSmallLabels,["all",["==",["get","countryId"],id],["==",["get","placementMode"],POINT_LABEL_MODE],["==",["get","overlapAtClose"],true]])}else{for(const layer of [L.capitalLabels,L.capitalDots])if(map.getLayer(layer))map.setLayoutProperty(layer,"visibility","visible");if(map.getLayer(L.glyphLabelFills))map.setFilter(L.glyphLabelFills,null);if(map.getLayer(L.glyphLabelOutlines))map.setFilter(L.glyphLabelOutlines,null);updateLabelFilter()}};
    window.__PAX_MAP_DEBUG__.getWorldRevision=()=>worldController.getState().revision;
    window.__PAX_MAP_DEBUG__.getMapProjectionRevision=()=>mapProjectionRef.current.appliedRevision;
    window.__PAX_MAP_DEBUG__.getMapSourceSyncSnapshot=()=>sourceController.snapshot();
    window.__PAX_MAP_DEBUG__.getMapSourceIdentity=id=>{const source=getRuntimeSource(id);if(!source)return null;let identity=sourceIdentities.get(source);if(!identity){identity=nextSourceIdentity++;sourceIdentities.set(source,identity)}return identity};
    window.__PAX_MAP_DEBUG__.getMapSourceFeatures=async(id)=>{const data=await getRuntimeSource(id)?.getData();return data?.type==="FeatureCollection"?data.features.map(feature=>({id:String(feature.id),countryId:typeof feature.properties?.countryId==="string"?feature.properties.countryId:null,ownerCountryId:typeof feature.properties?.ownerCountryId==="string"?feature.properties.ownerCountryId:null,displayName:typeof feature.properties?.displayName==="string"?feature.properties.displayName:null,projectionRevision:typeof feature.properties?.projectionRevision==="number"?feature.properties.projectionRevision:null,mapColor:typeof feature.properties?.mapColor==="string"?feature.properties.mapColor:null,classification:typeof feature.properties?.classification==="string"?feature.properties.classification:null})):[]};
    window.__PAX_MAP_DEBUG__.resynchronizeMapSources=()=>{sourceController.resynchronize(mapProjectionRef.current,getRuntimeSource);mapRevisionRef.current=sourceController.snapshot().revision;verifiedRevision=-1;resyncPending=true;setStatus("loading");requireRenderFrames()};
    window.__PAX_MAP_DEBUG__.getGlyphLabelFeatureCount=id=>glyphFeatures.filter(feature=>!id||feature.properties.countryId===id).length;
    window.__PAX_MAP_DEBUG__.getGlyphLabelInstanceCount=id=>new Set(glyphFeatures.filter(feature=>!id||feature.properties.countryId===id).map(feature=>feature.properties.labelInstanceId)).size;
    window.__PAX_MAP_DEBUG__.getRenderedGlyphLabelIds=()=>[...new Set(map.queryRenderedFeatures(undefined,{layers:[L.glyphLabelFills]}).map(feature=>String(feature.properties?.countryId??"")).filter(Boolean))];
    window.__PAX_MAP_DEBUG__.getCountryLabelLayerOrder=()=>map.getStyle().layers.map(layer=>layer.id).filter(id=>[L.countryLow,L.countryHigh,L.bordersLow,L.borders,L.admin1,L.hoverLow,L.hoverHigh,L.selectedLow,L.selectedHigh,L.playerLow,L.playerHigh,L.glyphLabelOutlines,L.glyphLabelFills,L.smallLabels,L.ultraSmallLabels].includes(id as never));
    window.__PAX_MAP_DEBUG__.setCountryInteractionState=state=>{const store=useGameSetupStore.getState();if("hoveredCountryId" in state)store.setHoveredCountry(state.hoveredCountryId??null);if(state.selectedCountryId)store.selectCountry(state.selectedCountryId);else if("selectedCountryId" in state)store.clearSelectedCountry();if(state.playerCountryId)store.confirmPlayerCountry(state.playerCountryId);applyStateFilters()};
    attachScenarioDebugTools(window.__PAX_MAP_DEBUG__,worldController);
    return()=>{disposed=true;applyMapRuntimeRef.current=null;applyLabelRuntimeRef.current=null;applyMapUiSettingsRef.current=null;delete window.__PAX_MAP_DEBUG__;window.removeEventListener("pax:focus-country",focus);window.removeEventListener("pax:retry-details",retry);resize.disconnect();map.remove();mapRef.current=null;mapRevisionRef.current=-1;markerRevisionRef.current=-1;labelRevisionRef.current=-1};
  },[updateDetailStatus,worldController]);

  useEffect(()=>{mapUiSettingsRef.current=uiSettings;applyMapUiSettingsRef.current?.()},[uiSettings]);

  useEffect(()=>{
    if(mapProjection.appliedRevision<mapProjectionRef.current.appliedRevision||mapProjection.appliedRevision<=mapRevisionRef.current)return;
    mapProjectionRef.current=mapProjection;
    applyMapRuntimeRef.current?.();
  },[mapProjection]);

  useEffect(()=>{
    if(initialMarkerProjection.appliedRevision<markerProjectionRef.current.appliedRevision||!shouldApplyCountryMapMarkerProjection(markerRevisionRef.current,initialMarkerProjection))return;
    markerProjectionRef.current=initialMarkerProjection;
    const map=mapRef.current;
    if(!map||(!map.loaded()&&markerRevisionRef.current<0))return;
    const capitals=map?.getSource(S.capitals) as {setData?:(data:unknown)=>void}|undefined;
    const smallCountries=map?.getSource(S.smallCountries) as {setData?:(data:unknown)=>void}|undefined;
    if(!capitals?.setData||!smallCountries?.setData)return;
    capitals.setData(initialMarkerProjection.capitals);
    smallCountries.setData(initialMarkerProjection.smallCountryMarkers);
    markerRevisionRef.current=initialMarkerProjection.appliedRevision;
  },[initialMarkerProjection]);

  useEffect(()=>{
    if(labelProjection.appliedRevision<labelProjectionRef.current.appliedRevision||labelProjection.appliedRevision<=labelRevisionRef.current)return;
    labelProjectionRef.current=labelProjection;
    applyLabelRuntimeRef.current?.();
  },[labelProjection]);

  useEffect(()=>{const map=mapRef.current;if(!map?.getLayer(L.selectedLow))return;const selectedFilter:["==",["get","countryId"],string]=["==",["get","countryId"],selected??""],playerFilter:["==",["get","countryId"],string]=["==",["get","countryId"],player??""];for(const id of [L.selectedLow,L.selectedHigh])if(map.getLayer(id))map.setFilter(id,selectedFilter);for(const id of [L.playerLow,L.playerHigh])if(map.getLayer(id))map.setFilter(id,playerFilter)},[selected,player]);
  return <section className="map-wrap" aria-label="2020년 세계 지도"><div ref={container} className="map" data-testid="world-map"/>{status!=="ready"&&<div className="map-status" role="status"><div className="box">{status==="loading"?"지도 데이터를 불러오는 중입니다":<>지도 데이터를 불러오지 못했습니다. <button onClick={()=>{try{window.__PAX_MAP_DEBUG__?.resynchronizeMapSources?.()}catch(error){console.error("Explicit map source resynchronization failed",error)}}}>재동기화</button></>}</div></div>}{detailStatus==="loading"&&<div className="detail-status" role="status">상세 경계를 불러오는 중…</div>}{detailStatus==="error"&&<div className="detail-status error">상세 경계 로딩 실패 <button onClick={()=>window.dispatchEvent(new Event("pax:retry-details"))}>재시도</button></div>}<div className="legend"><span><i style={{background:"#fff"}}/>선택</span><span><i style={{background:"#c1882e"}}/>플레이 국가</span></div></section>;
}
