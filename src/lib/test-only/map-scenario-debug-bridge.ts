import {createChinaProvinceDebugScenario} from "./china-province-debug-scenario";
import {createUsaStateDebugScenario} from "./usa-state-debug-scenario";
import type {WorldStateStoreController} from "@/stores/world-state-store";
import type {PaxMapDebug} from "@/types/map-debug";

export function attachScenarioDebugTools(
  debug: PaxMapDebug,
  worldController: WorldStateStoreController,
): void {
  let chinaScenario: ReturnType<typeof createChinaProvinceDebugScenario> | null = null;
  let usaScenario: ReturnType<typeof createUsaStateDebugScenario> | null = null;
  const china = () => chinaScenario ??= createChinaProvinceDebugScenario(worldController);
  const usa = () => usaScenario ??= createUsaStateDebugScenario(worldController);

  debug.splitChinaIntoProvinceCountries = () => china().split();
  debug.mergeChinaProvinceCountries = () => china().merge();
  debug.rollbackChinaProvinceCountries = () => chinaScenario
    ? chinaScenario.rollback()
    : Promise.resolve({active: false as const, restoredCountryId: "CHN" as const});
  debug.getChinaProvinceScenario = () => chinaScenario?.snapshot() ?? {
    active: false, provinceCountryIds: [], countryIdBySourceId: {}, mergedCountryId: null,
  };
  debug.splitUnitedStatesIntoStateCountries = () => usa().split();
  debug.mergeUnitedStatesStateCountries = () => usa().merge();
  debug.rollbackUnitedStatesStateCountries = () => usaScenario
    ? usaScenario.rollback()
    : Promise.resolve({active: false as const, restoredCountryId: "USA" as const});
  debug.getUnitedStatesStateScenario = () => usaScenario?.snapshot() ?? {
    active: false, stateCountryIds: [], countryIdBySourceId: {}, mergedCountryId: null,
  };
}
