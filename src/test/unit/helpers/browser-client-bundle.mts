import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { moduleRunnerTransform, type Plugin, type ViteDevServer } from "vite";

const ENTRIES = ["coverage-board", "traceability-view", "xray-setup"] as const;
const QUERY = "?specwright-browser-bundle";
interface BrowserBundle {
  code: string;
  map: string;
  evaluatedCode: string;
  sources: Map<string, string>;
}
const bundles = new Map<string, Promise<BrowserBundle>>();

function entryPath(entry: (typeof ENTRIES)[number], root: string): string {
  return resolve(root, `src/webview/${entry}.ts`).replaceAll("\\", "/");
}

async function bundle(entry: string): Promise<BrowserBundle> {
  const pending = bundles.get(entry);
  if (pending) {
    const cached = await pending;
    // Workers reused in watch mode must observe edits too, including edits of the same byte length.
    try {
      if ([...cached.sources].every(([file, source]) => readFileSync(file, "utf8") === source)) {return cached;}
    } catch { /* A removed dependency invalidates the old graph; rebuild the current entry. */ }
  }
  const next = build({
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    format: "iife",
    // Keep uncalled functions in the report instead of removing their denominators.
    treeShaking: false,
    sourcemap: "external",
    outfile: `${entry}.js`,
    write: false,
  }).then(async (output) => {
    const code = `${output.outputFiles.find((file) => file.path.endsWith(".js"))!.text}\n//# sourceURL=${pathToFileURL(entry).href}${QUERY}\n`;
    const map = output.outputFiles.find((file) => file.path.endsWith(".map"))!.text;
    const parsedMap = JSON.parse(map) as NonNullable<Parameters<typeof moduleRunnerTransform>[1]> & { sources: string[]; sourcesContent: string[] };
    const sources = new Map(parsedMap.sources.map((file, index) => [resolve(dirname(entry), file), parsedMap.sourcesContent[index]!]));
    // Vite also inserts statement separators in SSR mode; evaluate that same transform.
    const transformed = await moduleRunnerTransform(code, parsedMap, `${entry}.js${QUERY}`, code);
    return { code, map, evaluatedCode: transformed!.code, sources };
  }).catch((error: unknown) => {
    if (bundles.get(entry) === next) {bundles.delete(entry);}
    throw error;
  });
  bundles.set(entry, next);
  return next;
}

export async function browserClientCode(entry: (typeof ENTRIES)[number], root = process.cwd()): Promise<string> {
  return (await bundle(entryPath(entry, root))).evaluatedCode;
}

export function browserClientCoveragePlugin(root = process.cwd()): Plugin {
  const entryPaths = new Set(ENTRIES.map((entry) => entryPath(entry, root)));
  let server: ViteDevServer | undefined;
  return {
    name: "specwright-browser-bundle-coverage",
    enforce: "pre",
    configureServer(value) {server = value;},
    watchChange() {
      bundles.clear();
      for (const environment of Object.values(server?.environments ?? {})) {
        for (const entry of entryPaths) {
          const module = environment.moduleGraph.getModuleById(`${entry}.js${QUERY}`);
          if (module) {environment.moduleGraph.invalidateModule(module);}
        }
      }
    },
    resolveId(id) {
      if (!id.endsWith(QUERY)) {return undefined;}
      const entry = id.slice(0, -QUERY.length).replaceAll("\\", "/");
      // Coverage must parse the exact evaluated JavaScript, without a second TS transform.
      return entryPaths.has(entry) ? `${entry}.js${QUERY}` : undefined;
    },
    async load(id) {
      if (!id.endsWith(`.js${QUERY}`)) {return undefined;}
      const entry = id.slice(0, -(`.js${QUERY}`).length).replaceAll("\\", "/");
      if (!entryPaths.has(entry)) {return undefined;}
      const result = await bundle(entry);
      for (const file of result.sources.keys()) {this.addWatchFile(file);}
      return { code: result.code, map: result.map };
    },
  };
}
