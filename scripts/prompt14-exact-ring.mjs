// Finite IEEE-754 coordinates as integers in units of 2^-1074. This module
// depends on neither catalog normalization nor generation/preservation code.
const view=new DataView(new ArrayBuffer(8)),MIN_NORMAL=2**-1022,U=Number.EPSILON/2;
export function finiteDoubleInteger(value){
 if(!Number.isFinite(value))throw Error('Nonfinite coordinate');
 view.setFloat64(0,value);const bits=view.getBigUint64(0),exponent=Number(bits>>52n&2047n),mantissa=bits&((1n<<52n)-1n),integer=exponent?((1n<<52n)|mantissa)<<BigInt(exponent-1):mantissa;return bits>>63n?-integer:integer;
}
export function exactRingNumerator(ring){
 const points=ring.map(p=>p.map(finiteDoubleInteger));let sum=0n;for(let i=1;i<points.length;i++)sum+=points[i-1][0]*points[i][1]-points[i][0]*points[i-1][1];return sum;
}
export const exactRingSign=ring=>{const n=exactRingNumerator(ring);return n>0n?1:n<0n?-1:0;};
// Correctly round numerator/denominator * 2^power, including subnormals.
// Area underflow is reported explicitly, never replaced with an epsilon.
function rationalNumber(numerator,denominator,power,requireNonzero=false){
 if(!denominator)throw Error('Zero exact denominator');if(!numerator)return 0;
 const negative=(numerator<0n)!==(denominator<0n),n=numerator<0n?-numerator:numerator,d=denominator<0n?-denominator:denominator;
 let exponent=n.toString(2).length-d.toString(2).length+power;const difference=exponent-power;
 if(difference>=0?n<(d<<BigInt(difference)):(n<<BigInt(-difference))<d)exponent--;
 const unit=Math.max(-1074,exponent-52),shift=power-unit,scaledN=shift>=0?n<<BigInt(shift):n,scaledD=shift<0?d<<BigInt(-shift):d;
 let q=scaledN/scaledD;const remainder=scaledN%scaledD;if(2n*remainder>scaledD||2n*remainder===scaledD&&(q&1n))q++;
 const value=Number(q)*2**unit;if(!Number.isFinite(value)||requireNonzero&&value===0)throw RangeError('Exact nonzero area is not representable as a finite nonzero Number');return negative?-value:value;
}
const areaNumber=n=>rationalNumber(n,1n,-2149,n!==0n);
// Each product has two subtractions and a multiply; difference/accumulation
// add O(n) rounding errors. gamma_(8n+32) conservatively bounds these errors
// against the absolute product sum, including rounding of that sum. Any
// subnormal/overflowing intermediate uses exact arithmetic instead.
function errorBound(absoluteProducts,count){const k=(8*count+32)*U;return k<1?k/(1-k)*absoluteProducts:Infinity;}
export function ringAreaEvaluation(ring){
 const [ox,oy]=ring[0];if(!Number.isFinite(ox)||!Number.isFinite(oy))throw Error('Nonfinite coordinate');let twice=0,absoluteProducts=0,ordinary=true;
 for(let i=1;i<ring.length;i++){
  const a=ring[i-1],b=ring[i];if(!a.every(Number.isFinite)||!b.every(Number.isFinite))throw Error('Nonfinite coordinate');
  const ax=a[0]-ox,ay=a[1]-oy,bx=b[0]-ox,by=b[1]-oy,left=ax*by,right=bx*ay;
  for(const v of [ax,ay,bx,by,left,right])if(!Number.isFinite(v)||v!==0&&Math.abs(v)<MIN_NORMAL)ordinary=false;
  if(left===0&&ax!==0&&by!==0||right===0&&bx!==0&&ay!==0)ordinary=false;
  twice+=left-right;absoluteProducts+=Math.abs(left)+Math.abs(right);
 }
 const bound=errorBound(absoluteProducts,ring.length),certified=ordinary&&Number.isFinite(twice)&&Number.isFinite(bound)&&bound>=MIN_NORMAL&&Math.abs(twice)>bound;
 return {twice,bound,certified};
}
export function signedRingArea(ring){const r=ringAreaEvaluation(ring);return r.certified?r.twice/2:areaNumber(exactRingNumerator(ring));}
export function ringAreaSign(ring){const r=ringAreaEvaluation(ring);return r.certified?Math.sign(r.twice):exactRingSign(ring);}
export function exactPolygonAreaNumerator(polygon){
 const absolute=n=>n<0n?-n:n;return polygon.reduce((sum,r,i)=>sum+(i===0?1n:-1n)*absolute(exactRingNumerator(r)),0n);
}
export function polygonArea(polygon){
 let area=0,total=0,vertices=0,ringError=0,exact=false;for(const [i,ring] of polygon.entries()){const r=ringAreaEvaluation(ring),value=Math.abs(r.certified?r.twice/2:areaNumber(exactRingNumerator(ring)));area+=(i===0?1:-1)*value;total+=value;vertices+=ring.length;ringError+=r.bound/2;exact||=!r.certified;}
 return !exact&&Number.isFinite(area)&&Math.abs(area)>ringError+errorBound(total,vertices)?area:areaNumber(exactPolygonAreaNumerator(polygon));
}
export function positivePolygonAreaAtMost(polygon,maximum){
 if(!(Number.isFinite(maximum)&&maximum>0))throw Error('Positive finite area bound required');
 const n=exactPolygonAreaNumerator(polygon);return n>0n&&n<=(finiteDoubleInteger(maximum)<<1075n);
}
export function exactRingMoments(ring){
 const points=ring.map(p=>p.map(finiteDoubleInteger));let twice=0n,x=0n,y=0n;
 for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],cross=a[0]*b[1]-b[0]*a[1];twice+=cross;x+=(a[0]+b[0])*cross;y+=(a[1]+b[1])*cross;}
 if(!twice)throw Error('Zero exact area ring');return {area:areaNumber(twice),centroid:[rationalNumber(x,3n*twice,-1074),rationalNumber(y,3n*twice,-1074)]};
}
