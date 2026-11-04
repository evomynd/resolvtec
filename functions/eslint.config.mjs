import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    ignores: ["lib/**", "node_modules/**"],
  },
);
