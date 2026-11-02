import type {SimulationContextV1} from '../simulation-context';

/** Lookup tools and validation retain the full host context; the model starts with a compact view. */
export function createModelSimulationContext(context: SimulationContextV1): SimulationContextV1 {
  if (!context.regionCatalog) return context;
  const relevant = new Set(context.countries.map((country) => country.countryId));
  relevant.add(context.playerCountry.countryId);
  for (const authority of context.territorialControlAuthorities ?? []) {
    relevant.add(authority.actorCountryId);
    if (authority.targetCountryId) relevant.add(authority.targetCountryId);
  }
  const territoryDirectory = context.territoryDirectory.filter((entry) => relevant.has(entry.countryId));
  const clipped = context.metadata.clipped.filter((entry) => !entry.section.startsWith('directory:')
    || relevant.has(entry.section.slice('directory:'.length)));
  if (territoryDirectory.length < context.territoryDirectory.length) clipped.push({
    section: 'territoryDirectory',
    omittedCount: context.territoryDirectory.length - territoryDirectory.length,
    reason: 'Other country territory IDs remain available through inspect_country_territories and region lookup tools',
  });
  return {
    ...context,
    countryDirectory: context.countryDirectory.map((country) => ({...country, searchAliases: []})),
    territoryDirectory,
    metadata: {clipped},
  };
}
