import type {WorldStateStoreController} from "@/stores/world-state-store";
import type {PaxMapDebug} from "@/types/map-debug";

/** Production boundary: scenario fixtures are supplied only by the E2E build alias. */
export function attachScenarioDebugTools(
  _debug: PaxMapDebug,
  _worldController: WorldStateStoreController,
): void {
  void _debug;
  void _worldController;
}
