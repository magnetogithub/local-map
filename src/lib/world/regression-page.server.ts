import 'server-only';

// E2E builds replace this inert module through the explicit build configuration.
export async function resolveRegressionPage(mode: 'setup' | 'game') {
  void mode;
  return null;
}
