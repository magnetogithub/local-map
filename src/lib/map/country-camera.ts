export function nearestWrappedLongitude(targetLongitude:number,currentLongitude:number){return targetLongitude+Math.round((currentLongitude-targetLongitude)/360)*360}
