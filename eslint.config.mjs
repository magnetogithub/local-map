import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  { rules: { "react-hooks/set-state-in-effect": "off", "@next/next/no-img-element": "off", "jsx-a11y/role-supports-aria-props": "off" } },
  { files: ["scripts/**/*.cjs"], rules: { "@typescript-eslint/no-require-imports": "off" } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-e2e/**",
    ".next-e2e-review-g/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated verification bundles and scratch reproductions are not source.
    ".tmp/**",
    "reports/**",
    "test-results/**",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;
