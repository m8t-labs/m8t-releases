import m8tConfig from "@m8t-stack/eslint-config";

export default [
  ...m8tConfig,
  {
    languageOptions: {
      parserOptions: { project: ["./tsconfig.eslint.json"], tsconfigRootDir: import.meta.dirname },
    },
  },
];
