import type {ActiveCountryId} from "../world/country-id";
import type {WorldStateV2} from "../world/world-state-v2";
import type {CountryCapitalProjection} from "./country-capital-projection";

export type CountryPanelPresentationEntry = Readonly<{
  countryId: ActiveCountryId;
  iso3: string;
  flagCode: string;
  region: string;
}>;

export type CountryPanelCoreProjectionEntry = Readonly<{
  countryId: ActiveCountryId;
  iso3: string;
}>;

export type CountryPanelInputProjectionEntry = Readonly<{
  nameKo: string;
  nameEn: string;
  capitalKo: string;
  capitalEn: string;
  flagCode: string;
  region: string;
}>;

export type CountryPanelProjection = Readonly<{
  revision: number;
  appliedRevision: number;
  coreById: ReadonlyMap<ActiveCountryId, CountryPanelCoreProjectionEntry>;
  inputById: ReadonlyMap<ActiveCountryId, CountryPanelInputProjectionEntry>;
  playableById: ReadonlyMap<ActiveCountryId, boolean>;
}>;

export type SerializedCountryPanelProjection = Readonly<{
  revision: number;
  appliedRevision: number;
  core: readonly CountryPanelCoreProjectionEntry[];
  input: readonly (CountryPanelInputProjectionEntry & Readonly<{countryId: ActiveCountryId}>)[];
  playable: readonly (readonly [ActiveCountryId, boolean])[];
}>;

export type CountryPanelView = CountryPanelCoreProjectionEntry & CountryPanelInputProjectionEntry & Readonly<{
  playable: boolean;
}>;

const activeCountryId = (countryId: string) => countryId as ActiveCountryId;

export const emptyCountryPanelProjection: CountryPanelProjection = Object.freeze({
  revision: 0,
  appliedRevision: 0,
  coreById: new Map(),
  inputById: new Map(),
  playableById: new Map(),
});

export function createCountryPanelPresentationEntries(
  metadata: readonly {
    id: string;
    iso3: string;
    flagCode: string;
    region: string;
  }[],
): Readonly<Record<string, CountryPanelPresentationEntry>> {
  return Object.freeze(Object.fromEntries(metadata.map((country) => [
    country.id,
    Object.freeze({
      countryId: activeCountryId(country.id),
      iso3: country.iso3,
      flagCode: country.flagCode,
      region: country.region,
    }),
  ])));
}

export function createCountryPanelProjection(
  state: WorldStateV2,
  capitalProjection: CountryCapitalProjection,
  presentationById: Readonly<Record<string, CountryPanelPresentationEntry>>,
): CountryPanelProjection {
  if (capitalProjection.revision !== state.revision) {
    throw new Error(
      `Country panel capital projection revision ${capitalProjection.revision} does not match state revision ${state.revision}`,
    );
  }
  const coreById = new Map<ActiveCountryId, CountryPanelCoreProjectionEntry>();
  const inputById = new Map<ActiveCountryId, CountryPanelInputProjectionEntry>();
  const playableById = new Map<ActiveCountryId, boolean>();

  for (const countryId of state.countryOrder) {
    const country = state.countriesById[countryId];
    const presentation = presentationById[countryId];
    const capital = capitalProjection.featuresByCountryId.get(countryId);
    coreById.set(countryId, Object.freeze({
      countryId,
      iso3: presentation?.iso3 ?? countryId,
    }));
    inputById.set(countryId, Object.freeze({
      nameKo: country.names.shortKo,
      nameEn: country.names.english,
      capitalKo: capital?.properties.nameKo ?? "??",
      capitalEn: capital?.properties.nameEn ?? "??",
      flagCode: presentation?.flagCode ?? countryId,
      region: presentation?.region ?? "",
    }));
    playableById.set(countryId, country.politicalStatus === "sovereign");
  }

  return Object.freeze({
    revision: state.revision,
    appliedRevision: state.revision,
    coreById,
    inputById,
    playableById,
  });
}

export function serializeCountryPanelProjection(
  projection: CountryPanelProjection,
): SerializedCountryPanelProjection {
  return Object.freeze({
    revision: projection.revision,
    appliedRevision: projection.appliedRevision,
    core: Object.freeze([...projection.coreById.values()]),
    input: Object.freeze([...projection.inputById.entries()].map(([countryId, input]) =>
      Object.freeze({countryId, ...input}),
    )),
    playable: Object.freeze([...projection.playableById.entries()].map(([countryId, playable]) =>
      Object.freeze([countryId, playable] as const),
    )),
  });
}

export function deserializeCountryPanelProjection(
  projection: SerializedCountryPanelProjection,
): CountryPanelProjection {
  return Object.freeze({
    revision: projection.revision,
    appliedRevision: projection.appliedRevision,
    coreById: new Map(projection.core.map((entry) => [entry.countryId, Object.freeze(entry)])),
    inputById: new Map(projection.input.map(({countryId, ...input}) => [
      countryId,
      Object.freeze(input),
    ])),
    playableById: new Map(projection.playable),
  });
}

export function isCountryPanelPlayable(
  projection: CountryPanelProjection,
  countryId: string | null,
): boolean {
  if (countryId === null) return false;
  const activeId = activeCountryId(countryId);
  return projection.coreById.has(activeId) &&
    projection.inputById.has(activeId) &&
    projection.playableById.get(activeId) === true;
}

export function getCountryPanelView(
  projection: CountryPanelProjection,
  countryId: string | null,
): CountryPanelView | null {
  if (countryId === null) return null;
  const activeId = activeCountryId(countryId);
  const core = projection.coreById.get(activeId);
  const input = projection.inputById.get(activeId);
  const playable = projection.playableById.get(activeId);
  return core && input && playable !== undefined
    ? Object.freeze({...core, ...input, playable})
    : null;
}
