import {GameSetupShell} from "@/components/layout/GameSetupShell";
import {createCountryCapitalProjection} from "@/lib/projection/country-capital-projection";
import {
  createCountryPanelProjection,
  serializeCountryPanelProjection,
} from "@/lib/projection/country-panel-projection";
import {createCommittedCountrySearchProjection} from "@/lib/projection/committed-country-search-projection";
import {createLabelProjection, serializeLabelProjection} from "@/lib/projection/label-projection-checkpoint";
import {serializeCountrySearchProjection} from "@/lib/projection/country-search-index-patch";
import {loadProductionSubdivisionCatalog} from "@/lib/simulation/production-subdivision-catalog.server";
import {
  createInitialWorldStateV2Bootstrap,
  createProductionCountryMapColorSeeds,
  createProductionCountryPanelPresentationEntries,
  createProductionInitialWorldStateV2,
  createProductionSmallCountryMarkerSeeds,
} from "@/lib/world/initial-world-state-v2";
import {serializeWorldStateV2} from "@/lib/world/world-state-v2";

type Props = Readonly<{mode: "setup" | "game"}>;

export function WorldAppPage({mode}: Props) {
  const initial = createProductionInitialWorldStateV2();
  const initialWorldState = initial.worldState;
  const panelPresentationEntries = createProductionCountryPanelPresentationEntries();
  const capitalProjection = createCountryCapitalProjection(
    initialWorldState,
    initial.countryCapitalsById,
  );

  return <GameSetupShell
    mode={mode}
    initialWorldState={createInitialWorldStateV2Bootstrap(initialWorldState)}
    initialWorldSnapshot={serializeWorldStateV2(initialWorldState)}
    capitalSeeds={initial.countryCapitalsById}
    smallCountryMarkerSeeds={createProductionSmallCountryMarkerSeeds()}
    panelPresentationEntries={panelPresentationEntries}
    countryMapColorSeeds={createProductionCountryMapColorSeeds()}
    initialCountrySearchProjection={serializeCountrySearchProjection(
      createCommittedCountrySearchProjection(initialWorldState),
    )}
    initialCountryPanelProjection={serializeCountryPanelProjection(
      createCountryPanelProjection(
        initialWorldState,
        capitalProjection,
        panelPresentationEntries,
      ),
    )}
    initialLabelProjection={serializeLabelProjection(createLabelProjection(initialWorldState))}
    subdivisionCatalog={loadProductionSubdivisionCatalog()}
  />;
}
