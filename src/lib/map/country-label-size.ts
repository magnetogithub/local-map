export const COUNTRY_LABEL_MAX_ZOOM=9;
export const POINT_LABEL_MIN_WORLD_UNITS=.1;
export function worldSpaceFontSize(fontSizeWorldUnits:number,zoom:number,minWorldUnits=0){return Math.max(fontSizeWorldUnits,minWorldUnits)*2**zoom}
export function worldSpaceTextSizeExpression(minWorldUnits=0){const base=minWorldUnits>0?["max",minWorldUnits,["get","fontSizeWorldUnits"]]:["get","fontSizeWorldUnits"],expression:unknown[]=["interpolate",["exponential",2],["zoom"]];for(let zoom=0;zoom<=COUNTRY_LABEL_MAX_ZOOM;zoom++){expression.push(zoom,zoom===0?base:["*",base,2**zoom])}return expression as never}
