function flagEmoji(code:string){
  if(!/^[A-Z]{2}$/i.test(code))return "◇";
  return [...code.toUpperCase()].map(letter=>String.fromCodePoint(127397+letter.charCodeAt(0))).join("");
}

export function CountryFlag({code,name}:{code:string;name:string}){
  return <div className="flag" role="img" aria-label={`${name} flag`}>{flagEmoji(code)}</div>;
}
