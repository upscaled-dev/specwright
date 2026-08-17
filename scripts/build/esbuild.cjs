const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(
          `    ${location.file}:${location.line}:${location.column}:`
        );
      });
      console.log("[watch] build finished");
    });
  },
};

async function main() {
  const nodeContext = await esbuild.context({
    entryPoints: {
      extension: "src/extension.ts",
      "specwright-live-reporter": "src/test-providers/specwright-live-reporter.ts",
    },
    bundle: true,
    format: "cjs",
    minify: production,
    // "linked" writes dist/*.map with a sourceMappingURL comment; .vscodeignore
    // excludes the maps from the VSIX, and the retained CI artifact stays attachable.
    sourcemap: production ? "linked" : true,
    sourcesContent: false,
    platform: "node",
    outdir: "dist",
    external: ["vscode"],
    logLevel: "silent",
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  });
  const webviewContext = await esbuild.context({
    entryPoints: {
      "coverage-board": "src/webview/coverage-board.ts",
      "xray-setup": "src/webview/xray-setup.ts",
    },
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: production ? "linked" : true,
    sourcesContent: false,
    platform: "browser",
    outdir: "dist",
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin],
  });
  if (watch) {
    await Promise.all([nodeContext.watch(), webviewContext.watch()]);
  } else {
    await Promise.all([nodeContext.rebuild(), webviewContext.rebuild()]);
    await Promise.all([nodeContext.dispose(), webviewContext.dispose()]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
