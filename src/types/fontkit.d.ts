declare module "fontkit" {
  export type FontkitPathCommand={command:"moveTo"|"lineTo"|"bezierCurveTo"|"quadraticCurveTo"|"closePath";args:number[]};
  export type FontkitGlyph={id:number;codePoints:number[];advanceWidth:number;path:{commands:FontkitPathCommand[]}};
  export type FontkitGlyphPosition={xAdvance:number;yAdvance:number;xOffset:number;yOffset:number};
  export type FontkitFont={unitsPerEm:number;postscriptName:string;layout:(text:string)=>{glyphs:FontkitGlyph[];positions:FontkitGlyphPosition[]}};
  export function create(buffer:Uint8Array,postscriptName?:string):FontkitFont;
}
